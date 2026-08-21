# BAO Court: A Just-in-Time FROST Threshold Oracle for Prediction-Market Disputes

**Version:** 0.5.3 (tracks `@bao/court` v0.5.3 — this repository)
**Status:** Cryptographic, escrow, and settlement-rail protocol layers complete
and test-covered (600/600 in-package, `tsc` clean); adversarially reviewed
(v0.2.1 hardening; 2026-08-18 hardening); rail
*execution*, cross-client ceremonies, and on-chain phase enforcement remain
host-side / pre-production.
**Audience:** cryptographers, protocol engineers, researchers. We assume
familiarity with Schnorr signatures, Shamir secret sharing, and Nostr.

---

## Abstract

We present BAO Court, a **dispute-only, just-in-time (JIT) threshold oracle**
for prediction-market settlement. Normal markets resolve through a primary
oracle path; when a participant disputes an outcome, a jury of $N$ stake-backed
jurors is drawn by public, verifiable lottery, runs a Pedersen distributed key
generation (DKG) to produce an aggregate BIP-340 public key
$P_{\mathrm{dispute}}$ — with no party ever holding the corresponding secret —
votes under commit–reveal, and produces a **FROST threshold Schnorr
attestation** over the verdict, published as a Nostr kind-39007 event. The
attestation is a *standard* Schnorr signature: it reveals no threshold
structure and verifies against $P_{\mathrm{dispute}}$ with unmodified BIP-340
verification. Juror economics are enforced by a deterministic escrow ledger
with Kleros-style slashing (coherent jurors share the slashed pool; incoherent
jurors lose 50%; non-reveal and double-voting jurors lose 100%), and settlement
is specified for two rails — Lightning hold invoices (social slashing) and
Liquid P2WSH/Taproot escrow (script-enforced) — as pure, host-executed
protocol math. The jury forms only when a dispute exists, so juror capital is
never locked for the lifetime of a market. The reference implementation is
this repository: platform-neutral TypeScript, 592-property/test-strong suite,
plus a deterministic end-to-end simulation harness that runs the entire
pipeline — selection, DKG, voting, threshold signing, attestation validation,
slashing, and both settlement rails — in one process with no network.

**Keywords:** threshold signatures, FROST, distributed key generation,
prediction markets, dispute resolution, Nostr, Bitcoin, Liquid, Lightning.

---

## 1. Introduction

### 1.1 The status quo

Centralized prediction markets concentrate three powers in one operator:
resolution (deciding outcomes), custody (holding funds), and appeal (overturning
resolutions). Even protocols that decentralize custody typically keep a
single-key oracle for resolution and a server-administered fallback for
disputes. Both are single points of failure and compromise.

### 1.2 Desired properties

| Property | Meaning |
|----------|---------|
| **Threshold security** | No single party — including the platform — can unilaterally release dispute funds. |
| **Self-custody** | Winners claim payouts with their own keys; jurors only sign attestations. |
| **Censorship resistance** | A timelock refund path exists if the dispute oracle stalls. |
| **Privacy** | On-chain artifacts reveal no threshold structure. |
| **Verifiability** | Jury selection, voting, and attestations are publicly auditable and recomputable. |
| **Availability** | $M$-of-$N$ jurors suffice; $N-M$ may be offline or malicious. |
| **Capital efficiency** | Juror stake is locked only while a dispute is active. |
| **Rail portability** | One attestation format drives settlement on multiple rails. |

### 1.3 Why FROST

FROST (Flexible Round-Optimized Schnorr Threshold signatures [1]) yields a
single, ordinary BIP-340 signature from an $M$-of-$N$ group. Against
script-level multisig it offers: one signature and one public key on-chain
(cost and privacy), native tolerance of absentee signers, Taproot/BIP-341
compatibility, and operation over secp256k1 — the curve shared by Bitcoin,
Liquid, and Lightning. Its two-round signing with per-message binding factors
resists the nonce-reuse and rogue-key attacks that plague naive threshold
Schnorr constructions.

### 1.4 Contributions

1. A complete **JIT dispute-oracle protocol**: verifiable stake-weighted
   lottery selection, fail-closed Pedersen DKG with possession-bound
   complaints, roster-bound commit–reveal voting, frozen-verdict FROST
   signing, and a validated attestation format.
2. A **deterministic economic layer**: bond ownership proofs, an escrow
   ledger state machine, and a redistribution plan with a checkable
   conservation invariant.
3. A **dual-rail settlement specification** (Lightning hold invoices; Liquid
   P2WSH/Taproot escrow) in which every value an observer needs is
   recomputable from public inputs, while key custody and broadcasting stay
   with the host.
4. A **reference implementation and whole-court simulation harness** with an
   adversarial-review record (§10).

---

## 2. Cryptographic preliminaries

### 2.1 Notation

Let $\mathbb{G}$ be the secp256k1 group of prime order $q$ with generator $G$.
We write scalar multiplication additively: $[x]G$. Lowercase letters are
scalars in $\mathbb{Z}_q$; uppercase are group elements. $H$ is SHA-256.
A BIP-340 public key is the $x$-coordinate of $P = [p]G$, written $P_x$
("x-only"). $\|$ denotes concatenation of length- or domain-delimited fields;
all cross-party hashes in the implementation use length-prefixed,
domain-separated encodings (no concatenation ambiguity, no JSON dependence).

### 2.2 BIP-340 Schnorr signatures

A signature on $m$ under secret $p$ is $(R, z)$ with
$R = [r]G$ for uniform $r \xleftarrow{\$} \mathbb{Z}_q$,
$c = H(R_x \| P_x \| m)$, and $z = r + c\,p \bmod q$.
Verification checks $[z]G \stackrel{?}{=} R + [c]P$.

### 2.3 FROST signing

The group key $p$ is shared by a degree-$(M-1)$ Shamir polynomial $f$ [2];
participant $i$ holds $s_i = f(i)$ and $P = [f(0)]G$. To sign, $\ge M$
participants run two rounds [1]:

1. **Commit.** Each signer samples a nonce pair $(d_i, e_i)$ and publishes
   $(D_i, E_i) = ([d_i]G, [e_i]G)$.
2. **Sign.** With the full commitment set fixed, each signer forms the bound
   nonce $\rho_i = D_i + [H(i, m, \{(D_j, E_j)\})]\,E_i$ and partial
   signature $\sigma_i = d_i + H(i, m, \{(D_j,E_j)\})\,e_i + \lambda_i c s_i$
   ($\lambda_i$ the Lagrange coefficient of $i$ at 0).

The aggregator outputs $(R, \sigma) = (\sum_i \rho_i,\ \sum_i \sigma_i)$, a
standard BIP-340 signature under $P$. Security reduces to the one-more
discrete-logarithm assumption in the random-oracle model [1]; the binding
factor $H(i, m, \{(D_j,E_j)\})$ is what ties every nonce to the exact
commitment set and message, defeating Drijvers-style forgeries [8].

### 2.4 Distributed key generation with possession-bound complaints

Production shares must come from a DKG — no dealer, and no machine ever holds
$p$. The implementation uses Pedersen's DKG [3] (PedPop variant; suite id
`pedpop-v1-experimental`): each participant deals a Feldman-verifiable [4]
Shamir sharing of a random contribution; the group key is the sum of all
constant terms.

The complaint sub-protocol is **possession-bound and victim-authored** (a
v0.2.1 hardening; full specification in `docs/COMPLAINT-PROTOCOL.md`):

> Only the recipient of an actually-received encrypted share may complain
> about it, and the complaint event must be signed by that recipient and
> anchor the accused's share event.

**Why this is load-bearing.** VSS defenses reveal evaluation points of the
accused's polynomial. If anyone could file complaints on behalf of arbitrary
"victims", an attacker could force $t$ public defenses against one honest
juror — revealing $t$ points of a degree-$(t-1)$ polynomial — and interpolate
that juror's secret contribution; repeating across $t$ honest jurors recovers
the group key. With possession binding, a coalition of $m$ malicious parties
can force at most $m$ genuine complaints against an honest juror (each
colluder controls exactly one recipient index), so under the honest-majority
condition $m + 1 \le t$ the number of exposed points stays strictly below the
interpolation threshold. The same binding kills the zero-cost ceremony DoS
(forged complaints that disqualify honest jurors at no cost to the attacker).

### 2.5 Encrypted transport

Private protocol messages (shares, complaints, backups) are carried as
NIP-44 v2 [5] encrypted payloads inside NIP-59 gift wraps [6]; unwrap paths
verify the recipient tag, the seal's Schnorr signature, seal-author equality
with the rumor author, and recompute the rumor id (v0.2.1 strict-unwrap
hardening).

---

## 3. System architecture

### 3.1 Roles

| Role | Function |
|------|----------|
| **Primary oracle** | Resolves the market normally (out of scope here). |
| **Juror candidates** | Stake-backed Nostr identities opting in per dispute. |
| **Selected jury** | $N$ jurors drawn by public lottery after the opt-in window. |
| **FROST dispute oracle** | The aggregate key $P_{\mathrm{dispute}}$ from the jury's JIT DKG. |
| **BAO Court** | The dispute layer: evidence, commit–reveal voting, slashing. |
| **Settlement contract** | Output with normal / dispute / refund spending paths. |
| **Winner** | Trader whose key satisfies the winning condition. |

### 3.2 Settlement contract paths

Every market locks funds with three mutually exclusive paths:

- **Path A — normal.** Primary-oracle attestation **and** winner signature.
- **Path B — dispute.** FROST attestation under $P_{\mathrm{dispute}}$
  **and** winner signature.
- **Path C — refund.** After absolute timelock $T$, the funder reclaims.

The conjunction in Path B is the critical safety property: **jurors attest;
they cannot spend.** The FROST aggregate key is an oracle key, not a spending
key — an attestation without the winner's signature is worthless on-chain.

### 3.3 Attestation format

A dispute override is a Nostr kind-39007 event whose `sig` tag carries the
FROST signature and whose `p` tag carries $P_{\mathrm{dispute}}$:

```json
{
  "kind": 39007,
  "tags": [
    ["e", "<market event id>", "", "root"],
    ["m", "<market id>"],
    ["p", "<x-only aggregate pubkey P_dispute>"],
    ["outcome", "YES"],
    ["round", "1"],
    ["nonce", "<x-only aggregate nonce R>"],
    ["sig", "<BIP-340 signature R || z>"],
    ["dispute", "<dispute event id>"],
    ["verdict", "<verdict commitment H(DisputeVerdict/v1, …)>"],
    ["e", "<supporting reveal event id>", "", "mention"],
    ["ver", "FROST-BIP340-v1"]
  ],
  "content": "{\"marketId\":\"…\",\"outcome\":\"YES\",\"round\":\"1\",\"message\":\"<signed digest>\",\"disputeEventId\":\"…\",\"verdictHash\":\"…\",\"supportingEventIds\":[\"…\"]}"
}
```

The signed message is exactly

$$m \;=\; H(\texttt{BAO-Court/AttestationMessage/v1} \;\|\; \texttt{marketId} \;\|\; \texttt{outcome} \;\|\; \texttt{round} \;\|\; \texttt{disputeEventId} \;\|\; \texttt{verdictHash})$$

where each field is UTF-8 **length-prefixed** under a domain tag
(`CanonicalWriter`; `buildAttestationMessage`). Delimiter-joined
concatenation is deliberately rejected: an attacker-controlled `marketId` or
`outcome` could embed the delimiter and alias another field or the dispute
id, so two distinct verdicts would hash to the same signed message. The
dispute event id binds the signature to one appeal, defeating cross-dispute
and cross-market replay.

The `verdict` tag is the **verdict commitment**

$$\texttt{verdictHash} \;=\; H(\texttt{BAO-Court/DisputeVerdict/v1} \;\|\; \texttt{disputeId} \;\|\; \texttt{outcome} \;\|\; \texttt{count} \;\|\; \texttt{sorted supporting reveal event ids})$$

(`hashDisputeVerdict`, canonical length-prefixed, order-independent). It is
computed at tally time — before any nonce is committed — and bound into the
signed message, so the FROST signature certifies **the tally that produced
the outcome**, not just the outcome: an attestation for an outcome that lost
the vote is *structurally invalid*, not merely suspicious. The supporting
reveal event ids ride as `e`-mention tags, so any observer can recompute the
tally from the public vote ledger and check it against the attested
commitment — selection-and-voting as a proof, not a claim. The wrapper event
is itself a valid, signed Nostr event from a publisher key; the FROST
signature rides inside, and the consumer-side validator
(`validateAttestationEvent`) checks: event validity, required singleton
tags (including a 64-hex `verdict` tag on kind-39007), `nonce == sig[0:64]`
(the embedded $R$), expected group key / dispute / market, outcome
whitelist, tag↔content agreement, message recomputation against the carried
verdict hash, and the Schnorr signature over $m$ under $P_{\mathrm{dispute}}$.

### 3.4 No DKG before disputes

Locking juror capital per market — some markets run for months — is
capital-inefficient and imposes standing-committee liveness requirements.
BAO Court therefore forms the jury and runs the DKG **only after a dispute is
filed**. The dispute event id doubles as the lottery seed input (§4), so the
jury cannot be pre-computed or reused across disputes.

---

## 4. Jury selection

### 4.1 Seed

$$\mathrm{seed} = H(\texttt{disputeEventId} \;\|\; \texttt{blockHash})$$

where `blockHash` is a confirmed Bitcoin block hash (default: 6
confirmations): publicly observable, unpredictable before mining, and
infeasible to bias without a deep reorg. The selection event publishes the
exact seed and block hash used, so **anyone recompute the draw**
(`verifyJurySelection`) — selection is a proof, not a claim.

### 4.2 Stake-weighted quadratic lottery

For each eligible candidate $j$ with stake $w_j$:

$$r_j = \frac{\mathrm{uint32BE}\big(H(\mathrm{seed} \| \mathrm{pubkey}_j)\big)}{2^{32}}, \qquad \pi_j = \frac{-\ln r_j}{\sqrt{w_j}}$$

The jury is the $N$ candidates with the **smallest** $\pi_j$; exact ties break
by pubkey ascending (insertion-order independent, fully reproducible).

**Proposition (exponential race).** *For uniform independent $r_j \in (0,1)$,
the first $N$ order statistics of $\{\pi_j\}$ sample candidates without
replacement with per-draw probability proportional to $\sqrt{w_j}$.*

*Proof sketch.* $-\ln r_j \sim \mathrm{Exp}(1)$, so
$\pi_j = (-\ln r_j)/\sqrt{w_j} \sim \mathrm{Exp}(\sqrt{w_j})$. The minimum of
independent exponentials is won by $j$ with probability
$\sqrt{w_j} / \sum_k \sqrt{w_k}$; the race repeats memorylessly for each
subsequent rank — precisely sampling without replacement at rates
$\sqrt{w_j}$. ∎

Quadratic weighting is a deliberate anti-plutocracy choice: a juror with
$4\times$ stake is only $2\times$ as likely to serve. Stake still prices
Sybils (each identity must lock capital and pass eligibility), but raw
capital cannot buy deterministic control of the jury.

### 4.3 Eligibility filters

Minimum web-of-trust score, minimum account age, minimum stake capacity,
market-category match, stake capacity ≥ 1% of market volume, confirmed stake
commitment (a *present* commitment that is not confirmed excludes the
candidate — fail-closed), and exclusion of pubkeys from a previously failed
selected set (reselection hygiene).

---

## 5. The dispute pipeline

1. **Dispute.** The challenger posts kind 38025 with evidence and a
   bond-locked stake (ownership proved per §6.1) within the dispute window.
2. **Candidacy.** Stake-backed identities opt in with kind 39001.
3. **Selection.** After the opt-in window, kind 39002 publishes $N$ jurors
   and $K$ backups with the seed (§4).
4. **DKG.** Selected jurors run the Pedersen ceremony of §2.4 (kind 38031
   commitments, kind 39003 encrypted shares, kind 38032 possession-bound
   complaints). Disqualification aborts the attempt; the Court reselects
   from backups rather than degrading the ceremony. A group key is computed
   only over a roster whose *every* member's commitment and share verified —
   a threshold-sized subset would derive a *different* group key and split
   the Court.
5. **Vote.** Jurors commit (kind 39004; `H(outcome \| salt)`) then reveal (kind 39014).
   Exactly one commitment per roster index; a reveal counts only against the
   juror's own earlier session-bound commitment; ties break deterministically
   (lexicographic); the tally reports `invalidReveals` as slashing evidence
   instead of throwing.
6. **Sign.** $\ge M$ coherent jurors run FROST (kind 39005 commitments,
   kind 39006 reveals/partials) over the *frozen* verdict. One nonce
   commitment per signer per attempt; equivocation aborts with blame.
7. **Attest.** Any observer aggregates and publishes kind 39007 (§3.3).
8. **Settle.** Watchers validate the attestation and route the override;
   the winner claims via Path B.

Default phase timings (host-configurable): dispute 1 d · opt-in 1 d ·
selection 2 h · DKG 1 d · vote commit 12 h · reveal 12 h · signing 12 h ·
claim 7 d → refund. *Production hardening item:* these deadlines must also be
enforced by the settlement contract (so a late attestation cannot unlock
funds after the refund locktime), not only by the coordinator.

---

## 6. Escrow lifecycle and slashing

Full specification: `docs/ESCROW-SLASHING.md`. All amounts are integer
satoshis; every function is pure; any observer recomputes the same plan.

### 6.1 Bond ownership proofs

A depositor proves control of the claimed bond UTXO with a BIP-340 signature
over a deterministic, domain-separated challenge:

$$\text{challenge} = H(\texttt{"BAO-Court/BondOwnership/v1"} \;\|\; \texttt{txid} \;\|\; \texttt{vout} \;\|\; \texttt{disputeId} \;\|\; \texttt{jurorPubkey} \;\|\; \texttt{nonce})$$

Binding txid, vout, dispute, juror, and an anti-replay nonce makes proofs
non-replayable across disputes and candidates. Combined with on-chain bond
verification (unspent, amount, script, confirmations), this closes the
"self-attested UTXO" gap: a candidate must *own* the output, not merely name
it.

### 6.2 The ledger

`EscrowLedger` is a serializable state machine per deposit
(`disputeId|purpose|pubkey`):

```
pending ──lock(proofOk)──▶ locked ─┬─▶ returned        (coherent, bond won)
    │                              ├─▶ slashed_50      (incoherent)
    └─(proof rejected)──▶ failed   ├─▶ slashed_100     (non-reveal, double-vote, bond lost)
                                   └─▶ redistributed   (pool transfer executed)
```

Invalid transitions throw; snapshots are JSON-safe. **No sats move inside the
package** — rail execution is the host's (§7).

### 6.3 Redistribution

Let $s$ be the per-juror stake, $B$ the dispute bond, $C$ the coherent set,
and define slash fractions $\alpha_I = 1/2$ (incoherent),
$\alpha_N = \alpha_D = 1$ (non-reveal, double-vote). The slashed pool is

$$P = \sum_{j \in I} \big(s - \lfloor s/2 \rfloor\big) \;+\; \sum_{j \in N \cup D} s \;+\; B\cdot\mathbb{1}[\text{dispute rejected}]$$

Each coherent juror receives $s + \lfloor P / |C| \rfloor$; the integer
remainder $P \bmod |C| < |C|$ is dust. If $|C| = 0$ and $P > 0$, the entire
pool routes to the treasury record (a fail-closed dust guard — no plan may
leave value unassigned). The disputer's bond is returned iff the dispute is
upheld. `verifyRedistributionIntegrity` checks conservation — *every
deposited sat is returned or accounted as dust* — so a faulty slash event is
rejected before any host acts on it.

### 6.4 Game-theoretic reading

The design follows the Kleros Schelling-point model [9]: voting with the
eventual majority is the focal strategy, so honesty is incentive-compatible
provided (i) the slash exceeds the bribe a juror can capture, and (ii)
selection is unpredictable (§4). The 50%/100% split distinguishes *wrong*
from *absent or equivocating*: incoherence may be honest error; non-reveal
and double-voting are protocol violations and are priced accordingly.

---

## 7. Settlement rails

Full specification: `docs/SETTLEMENT-RAILS.md`. The court package computes
*what must happen financially*; hosts execute it. The **secrecy boundary is
binding**: this public package contains protocol math, script trees, address
derivation, state machines, adapter contracts, and test fakes — and must
never contain keys, node URLs, credentials, or business policy. Hosts
implement the `LnRail` / `LiquidRail` contracts privately.

### 7.1 Panel A — Lightning hold invoices

Lightning cannot script-enforce a penalty, so Panel A implements *social
slashing*: coherent jurors get paid, incoherent jurors get nothing.

- **Deterministic preimage.**
  $\text{preimage} = H_{\text{dom}}(\texttt{disputeId} \| \texttt{role} \| \texttt{pubkey} \| \texttt{outcome} \| \texttt{attestationDigest} \| \texttt{round})$
  under domain `BAO-Court/LnPreimage/v1`. Binding the court's attestation
  digest means the holder cannot claim without the verdict the court signed.
  The payment hash is `SHA-256` of the **raw preimage bytes** (BOLT
  semantics).
- **Ledger.** `offer → held → settled | cancelled | expired | failed`, with
  guards (only an offer can be held; only a held, unexpired hold can be
  decided; expiry routes to refund).
- **Decisions.** `planDecisionsForHolds` maps the §6.3 plan: coherent /
  bond-won → `settle` (release preimage); incoherent / non-reveal /
  double-vote / bond-lost → `cancel`; unmentioned holds stay `unsettled`
  (host refunds unselected pledgers).
- **Audit.** Settle/cancel audit-event templates never include the preimage —
  only the payment hash.

### 7.2 Panel B — Liquid P2WSH / Taproot escrow

Panel B is script-enforced:

- `OP_<M> <pk_1> … <pk_N> OP_<N> OP_CHECKMULTISIG` P2WSH escrows (1–15 keys;
  x-only inputs lifted to compressed with correct parity; the standard
  `OP_FALSE` witness bug element).
- Taproot judge/refund trees: a judge leaf
  `<winner> CHECKSIGVERIFY <oracle> CHECKSIG` (jurors attest, the winner
  spends — §3.2) and a CLTV refund leaf.
- BIP-173/BIP-350 address derivation (bech32 v0 / bech32m v1; the witness
  version is a 5-bit word prepended to program words — byte-concatenation
  would silently corrupt it, covered by tests), BIP-341 tweaked programs with
  even-Y parity correction, sorted-pairs Taproot merkle trees.
- `buildReleaseSkeleton`: fee-exact, integer-only transaction skeletons with
  dust guards; `assembleMultisigWitness` for the M-of-N spend.

The script does not read the tally — the court's plan decides **which branch
to sign**, and the public builders construct exactly the transaction that
realizes the court's decision.

### 7.3 End-to-end determinism

Both rails consume the same `RedistributionPlan`, so one verdict drives both
panels without drift. The shipped end-to-end test (and the §9 simulation)
runs: court plan → LN decisions → Liquid branch → skeleton → broadcast,
through in-memory rail fakes, with same-seed reproducibility.

---

## 8. Security analysis

### 8.1 Threat model

The adversary may: statically corrupt up to $M-1$ jurors; compromise platform
infrastructure (but not juror keys); bribe jurors; front-run or censor
transactions; Sybil the candidate pool; flood or censor relays during any
window; and grind the selection seed by timing disputes.

**Assumptions.** (A1) The one-more discrete-log hardness underlying FROST [1]
and the random-oracle model for $H$; (A2) at least $M$ honest jurors opt in
and participate; (A3) honest jurors share authenticated, encrypted channels
(§2.5); (A4) for the complaint bound of §2.4, an honest majority in the
corruption sense $m+1 \le t$; (A5) the block-hash seed is unbiased at the
required confirmation depth. **Prototype deployments satisfy none of A2–A4 by
construction** (single-process ceremonies); see the honest status section of
the README.

### 8.2 Attack vectors

**A. Single rogue juror.** One Shamir share gives no information about
$f(0)$ (perfect privacy of Shamir sharing [2]); forgery needs $M$ shares.
*Mitigated by the threshold.*

**B. $M$-of-$N$ collusion.** $M$ colluders can sign any outcome. Raised cost:
$M \approx \lceil 2N/3 \rceil$ with unpredictable selection; public
commit–reveal voting makes collusion observable; slashing punishes
overturned attestations; the dual-panel design forces compromise of both
rails' evidence trails.

**C. Censorship / oracle stall.** The refund path (Path C) activates after
$T$. *Mitigated by construction.*

**D. Key theft.** No single secret exists; the adversary must steal $M$
independent juror keys. Proactive refresh (share re-randomization) further
bounds the value of stale shares.

**E. Front-running.** The attestation alone cannot spend — the winner's key
is required (§3.2).

**F. Sybil / stake concentration.** Quadratic lottery (§4.2), WoT /
account-age floors, escrowed pledges.

**G. Single-process ceremony (prototype).** Demo coordinators run the DKG and
signing in one process; compromising it observes all shares in memory.
*Documented; closed only by cross-client deployment (A2–A3), which is a
production gate, not a protocol change.*

**H. Nonce reuse.** A signer reusing a nonce across messages leaks its share
(linear algebra on two partial signatures). The implementation draws fresh
CSPRNG nonces per round, binds them to the full commitment set and message
(§2.3), persists a nonce-guard (a consumed commitment may never sign twice),
and aborts on equivocation.

**I. Phase-timing manipulation.** Rushing/delaying phases is bounded by
absolute windows (§5); production must enforce them in the contract (Path C
locktime), not only in the coordinator.

**J. Backup-juror manipulation.** Backups derive from the same seed (no
substitution); suppressing selected jurors to force backup activation is
bounded by transparent, published reselection, no-show slashing, and a
reselection deadline, after which the appeal refunds rather than degrading.

**K. Complaint forgery / forced share disclosure.** Closed in v0.2.1 by
possession-bound, victim-authored complaints (§2.4): group-secret extraction
via forced defenses and zero-cost ceremony DoS are both eliminated under
$m+1 \le t$.

### 8.3 Fail-closed invariants (implementation-level)

- **Unanimous-roster DKG** — any disqualification aborts; subset keys are
  forbidden (they would split the Court).
- **Private blame, never secret evidence** — verification failures carry
  indices and reasons, never decrypted shares (complaint paths must not be
  share-oracles).
- **Decrypt-before-gate** — shares are verified before readiness checks
  (avoids deadlock).
- **One commit, one reveal, roster-bound** — conflicting redeliveries throw;
  tallies only from verified reveals.
- **Frozen-verdict signing** — the signing-session hash binds verdict,
  signer set, threshold, and attempt; a changed verdict aborts, never
  silently re-signs.
- **Nonce-equivocation aborts** — partials only from the finalized signer
  set; aggregation requires ≥ threshold partials and a 64-byte signature.

---

## 9. Reference implementation and verification

This repository *is* the reference implementation: platform-neutral
TypeScript (browser and Node), no UI, no networking of its own, no
persistence — hosts inject clocks, storage, signers, relay pools, and rail
adapters. Module map: `README.md` §10.

- **Suite:** 600/600 tests green, `tsc --noEmit` clean (vitest).
  Coverage includes: BIP-350 official address vectors, FROST round-trips and
  partial-signature rejection, DKG complaint binding (forged/unattributable
  complaints rejected, genuine grievances disqualify, false complaints
  exonerate), poisoned-backup and negated-share rejection, strict NIP-59
  unwrap, escrow redistribution branches and integrity, LN ledger decisions,
  Liquid script/witness/skeleton correctness, adversarial parser fuzzing.
- **Whole-court simulation** (`npm run simulate:court`): deterministic,
  hermetic execution of the *entire* pipeline — lottery selection, Pedersen
  DKG, commit–reveal vote with one incoherent juror, FROST signing,
  production-path attestation validation (kind 39007 with full context),
  escrow slashing plan with integrity check, LN hold settle/cancel via the
  `LnRail` contract, Liquid escrow address + release skeleton + broadcast via
  the `LiquidRail` fake. Same seed ⇒ same group key, same Liquid address,
  same decisions. This is the "code and math backing" for every claim above:
  each section maps to executable, tested behavior.
- **Adversarial-review record:** `docs/FIXES-2026-08-15.md` (4 substantive
  findings fixed with regression tests), `docs/FIXES-2026-08-18.md`
  (canonical-hashing hardening), `docs/COMPLAINT-PROTOCOL.md`.

---

## 10. Production gates (honest status)

Implemented and test-covered **in the protocol package**: selection lottery
and verification; Pedersen DKG with possession-bound complaints; vote and
signing state machines; attestation format and validation; bond ownership
proofs; escrow ledger and slashing plan; LN and Liquid settlement-rail math;
appeal coordinator/watcher/timing with host-injected transport; NIP-44/NIP-59
private transport; host-key lifecycle, outbox, inbox, recovery.

Remains **host-side or pre-production** (engineering, not design):

1. Rail *execution* — real LN/Liquid node adapters that lock, settle,
   cancel, slash, and broadcast (private per the secrecy boundary).
2. Cross-client ceremonies — DKG/signing across independent juror devices
   over encrypted channels (the package ships the machinery; production
   consumers must run it distributed).
3. Contract-enforced phase deadlines on-chain (currently coordinator-level).
4. ChillDKG suite upgrade (planned; `pedpop-v1-experimental` is the active
   suite and must never be *labelled* ChillDKG; ChillDKG shares must never
   feed `@vbyte/frost` signing until BIP-445 vectors and cross-implementation
   parity pass).
5. Independent side-channel audit, differential fuzzing against a second
   FROST implementation, supply-chain pinning, and a public testnet bounty.

---

## 11. Conclusion

BAO Court replaces the single-key dispute fallback with a just-in-time FROST
threshold oracle: juries form only when needed, no party ever holds the group
secret, and the verdict is a single ordinary Schnorr signature that any
observer can verify. The economic layer (ownership proofs, escrow ledger,
Kleros-style slashing) and the dual-rail settlement specification (Lightning
hold invoices, Liquid script escrow) are deterministic and publicly
recomputable; custody and execution stay with hosts. The remaining work is
deployment engineering and independent auditing — the cryptographic and
protocol design is complete, implemented, and test-backed in this repository.

---

## References

1. C. Komlo, I. Goldberg. *FROST: Flexible Round-Optimized Schnorr Threshold
   Signatures.* IEEE S&P 2020. (See also draft-irtf-cfrg-frost.)
2. A. Shamir. *How to Share a Secret.* CACM 22(11), 1979.
3. T. P. Pedersen. *A Threshold Cryptosystem without a Trusted Party.*
   EUROCRYPT 1991.
4. P. Feldman. *A Practical Scheme for Non-interactive Verifiable Secret
   Sharing.* FOCS 1987.
5. NIP-44 — *Encrypted Payloads (Versioned).* Nostr Implementation
   Possibilities.
6. NIP-59 — *Gift Wrap.* Nostr Implementation Possibilities.
7. BIP-340 — *Schnorr Signatures for secp256k1*; BIP-341 — *Taproot*;
   BIP-350 — *Bech32m*.
8. M. Drijvers et al. *On the Security of Two-Round Multi-Signatures.*
   IEEE S&P 2019.
9. C. Lesaege, F. Ast, W. George. *Kleros: Short Paper v1.0.* 2018.
10. FROST-BIP340 DKG draft (Blockstream Research); BIP-445 (ChillDKG) —
    planned suite upgrade, not the active suite.
