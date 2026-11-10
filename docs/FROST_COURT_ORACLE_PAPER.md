# BAO Court: A Just-in-Time FROST Threshold Oracle for Prediction-Market Disputes

**Version:** 0.10.2 (tracks `@bao/court` v0.10.2 — this repository)
**Status:** Cryptographic, escrow, settlement-rail, universal-confirmation,
and batch-attestation protocol layers complete and test-covered (full suite
green, `tsc` clean); adversarially reviewed (v0.2.1 hardening; 2026-08-18
hardening; a ten-round symposium audit/verification program, §11.5); the
three ceremony phase machines are exhaustively model-checked and the pure
core is differentially parity-tested against independent reimplementations
(§11). Rail *execution*, cross-client ceremonies, and on-chain phase
enforcement remain host-side / pre-production.
**Audience:** cryptographers, protocol engineers, researchers. We assume
familiarity with Schnorr signatures, Shamir secret sharing, and Nostr.

---

## Abstract

We present BAO Court, a **just-in-time (JIT) threshold oracle** for
prediction-market settlement, extended by universal confirmation into a
panel-backed evidence layer for *every* outcome. Normal markets resolve through a primary
oracle path; when a participant disputes an outcome, a jury of $N$ stake-backed
jurors is drawn by public, verifiable lottery, runs a Pedersen distributed key
generation (DKG) to produce an aggregate BIP-340 public key
$P_{\mathrm{dispute}}$ — with no party ever holding the corresponding secret —
votes under commit–reveal, and produces a **FROST threshold Schnorr
attestation** over the verdict, published as a Nostr kind-39007 event. The
attestation is a *standard* Schnorr signature: it reveals no threshold
structure and verifies against $P_{\mathrm{dispute}}$ with unmodified BIP-340
verification. **Universal confirmation** extends the same machinery to
undisputed settlements: every market outcome — disputed or not — is confirmed
by a juror panel whose bond-witnessed challenge window opens a ×3-per-round
escalation ladder, and a standing epoch cohort's single FROST signature
certifies an entire epoch's verdict cohort through an RFC-6962 Merkle batch
attestation with in-band finality binding (kind 39018). Juror economics are
enforced by a deterministic escrow ledger
with Kleros-style slashing (coherent jurors share the slashed pool; incoherent
jurors lose 50%; non-reveal and double-voting jurors lose 100%), and settlement
is specified for two rails — Lightning hold invoices (social slashing) and
Liquid P2WSH/Taproot escrow (script-enforced) — as pure, host-executed
protocol math. The jury forms only when a dispute exists (or, for standing
cohorts, once per epoch), so juror capital is
never locked for the lifetime of a market. The reference implementation is
this repository: platform-neutral TypeScript, a 1,492-test-strong suite
(live count re-recorded per round in `docs/CROSS_CHECK.md` §1),
plus a deterministic end-to-end simulation harness that runs the entire
pipeline — selection, DKG, voting, threshold signing, attestation validation,
slashing, and both settlement rails — in one process with no network. The
evaluation methodology is itself part of the design: exhaustive finite-state
model checking of the ceremony machines (3.15M states, zero raw throws),
differential parity against independent reimplementations of every critical
pure function, a regenerable performance baseline, and a round-by-round
cryptographic literature audit (§11).

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
| **Capital efficiency** | Juror capital is locked only while a dispute is active (or while a cohort epoch is being served), not for a market's lifetime. |
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
   adversarial-review record (§12) and a formal evaluation methodology:
   exhaustive model checking, differential parity, and a regenerable
   performance baseline (§11).
5. **Universal confirmation and the escalation ladder** — every outcome
   (disputed or not) confirmed by a juror panel; bond-witnessed challenges;
   a ×3-per-round mass-vote ladder with flip-flop clawback flags and an
   append-only outcome history (§6).
6. **Epoch cohorts and batch attestations** — one DKG and one threshold
   signature per epoch cohort, certifying a whole verdict cohort through an
   RFC-6962 Merkle batch with in-band finality binding (§7).

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
| **FROST dispute oracle** | The aggregate key $P_{\mathrm{dispute}}$ — from the jury's JIT DKG, or from the standing epoch cohort (§7.1). |
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
The v2 extension of this format — in-band finality binding (epoch, tier,
threshold, signer-set root, batch root) and the v1↔v2 dispatch rules — is
specified in §7.3.

### 3.4 Empanelment modes: JIT juries and epoch cohorts

Locking juror capital per market — some markets run for months — is
capital-inefficient and imposes standing-committee liveness requirements.
BAO Court therefore forms the jury and runs the DKG **only after a dispute is
filed**. The dispute event id doubles as the lottery seed input (§4), so the
jury cannot be pre-computed or reused across disputes.

Universal confirmation (§6) adds a second empanelment mode without
reintroducing the standing-committee cost the JIT design avoids: a
*standing epoch cohort* (§7.1) runs the DKG **once per epoch** and reuses
the group key across every confirmation in the cohort's signed validity
window. The cohort key is still an oracle key only (§3.2), cohort members
are escrowed and slashed under the same ledger rules (§8), and rotation is
enforced by the signed handoff chain — a stale cohort cannot outlive its
validity window (§7.3).

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

### 4.4 Zero-stake reputation mode

Phase-0 deployments may run vetted juror pools without stake: `selection.ts`
accepts an optional pure `weightFn` (reputation weights in place of
$\sqrt{w_j}$) and a `zeroStakeAllowed` gate-waiver that lifts the
stake-capacity floor of §4.3. Both are fail-closed: a negative or
non-finite weight rejects the candidate, a zero weight opts them out
entirely, and the waived gate is an explicit parameter, never a silent
default. The default draw path is byte-identical when no `weightFn` is
supplied, and `verifyJurySelection` round-trips both modes — the draw stays
publicly recomputable either way. Stake-less weights weaken the Sybil price
of §4.2; they are a deployment-phase choice gated by the host, not a
protocol default. The statistical correctness of the weighted draw under
both modes is differentially parity-tested (§11.3).

---

## 5. The dispute pipeline

Steps 1–8 below are the *dispute* path. Universal confirmation (§6) runs the
same panel machinery for undisputed cases too: the proposal under
confirmation is the primary oracle's outcome, confirmations are public
endorsements, and only a bond-witnessed challenge opens the ladder. Both
paths end in the same verdict-hash domain, so one attestation format (§3.3)
serves both.

1. **Dispute.** The challenger posts kind 38025 with evidence and a
   bond-locked stake (ownership proved per §8.1) within the dispute window.
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

## 6. Universal confirmation

The dispute pipeline of §5 covers the *dispute* path only — the
overwhelming majority of markets, those nobody disputes, would otherwise
rest solely on the platform's primary-oracle attestation. Universal
confirmation (v0.8.0, per the
universal-confirmation design proposal) closes that gap: **every market
outcome — disputed or not — is confirmed by a juror panel**, so the court
produces positive evidence for every settlement and the primary oracle
becomes a proposal the panel can uphold or overturn, not an unappealable
fiat.

### 6.1 The confirmation machine

`courtConfirmationMachine.ts` is a pure, fail-closed reducer for one case:

```
confirm_open → confirm_closed → challenge_window
  ├─ (no challenge) → fee_settlement → final
  └─ (challenge)    → ladder_pending → ladder_vote_open →
                       ladder_vote_closed → resolve_round ─┐
         ┌─────────────────────────────────────────────────┤
         ├─ (last permitted round) → fee_settlement → final
         └─ (rounds remain)        → round_resolved
                                      ├─ concede  → fee_settlement → final
                                      └─ escalate → ladder_pending (next round)
```

- **Confirmations are public endorsements.** No commit/reveal — the
  confirmation hash (`hashCourtConfirmation`) binds the session, the
  proposal, and the roster index, so a confirmation is the juror's own
  attributable, non-replayable signed statement.
- **The challenge window is bond-witnessed.** A challenge must carry a
  verified bond witness: the host verifies the bond *before* dispatching the
  event, and the reducer binds the witness hash so any observer can
  re-verify it. A challenge without economic backing cannot open the ladder.
- **The ledger barrier.** Before value moves — at `resolve_round` (which
  steers clawbacks) and at `finalize` — the machine re-derives the
  confirmation and outcome ledgers canonically
  (`assertValidConfirmationLedger`, `assertValidOutcomeHistory`):
  consecutive 1..k round numbering, ballot closure of every recorded
  outcome, unique well-formed winner event ids and winner indices. A
  hand-restored or edited snapshot cannot direct clawbacks at arbitrary
  indices (finding F-3).
- **Fail-closed creation and restore.** Rosters below 3 members are rejected
  at creation (the confirmation quorum and round-panel semantics presuppose
  a panel); every restore re-verifies the same invariants; states are
  deep-frozen and every illegal event throws the machine's own typed error
  (§11.2 — zero raw throws across the model-checked state space).

### 6.2 The escalation ladder

A challenged case runs *mass-vote ladder rounds*: round $r$'s panel votes
publicly with the vote machine's commit–reveal and UTF-8 tie-break
semantics (§5, steps 5–6), and the majority outcome against the proposal
decides. Round panels grow host-side — reference sizes r1 = 15, r2 = 45,
r3 = 135 (×3 per round; FROST-subset selection is host policy, the machine
tracks rounds and votes) — and `maxLadderRounds` (default 2, bounded 1..5)
caps the round count. Escalation is **host-driven and explicit**: after a
non-final round resolves, the machine parks in `round_resolved`, where the
host plays `escalate` (next round) or `concede` (the current outcome becomes
final) — the machine never auto-escalates and never auto-concedes.
`open_ladder_round` may carry an expanded per-round roster (a superset of
the previous round is *not* required); mass votes validate against the
round panel, and round rosters re-verify at the close/resolve ledger
barrier.

### 6.3 Clawbacks, flip-flop flags, and outcome history

Two clawback rules price confirmation errors, both append-only and
idempotent:

- **`overturned_confirmation`** — when a round overturns the proposal,
  every confirming juror is flagged for clawback, exactly once (no
  duplicates on repeated overturns).
- **`round_flip`** — when round $r$'s winner differs from round $r{-}1$'s
  winner, round $r{-}1$'s *majority* voters are flagged: they followed an
  outcome the next panel rejected. Flags dedupe per
  (index, reason, round).

The append-only `outcomeHistory` records every round's
`{round, outcome, winnerEventIds, winnerIndices}` for host-side reputation
scoring (final-round weight 1.0, earlier rounds 0.5 — scoring itself is
host policy, §7.4). **Finality:** the verdict at `finalize` is the *last
resolved round's* winner, backed by that round's winning-vote event ids
(or the confirmation ids when the case was never challenged) — computed
under the same `hashCourtVerdict` domain as the mass-vote and dispute
paths, so kind-89 attestations reference it unchanged. (Attestation kinds:
**kind 89** for normal/confirmation verdicts, **kind 39007** for dispute
overrides — the validator accepts both, §7.3.)

### 6.4 Monotonic clock ledgers

All four ceremony machines — vote, confirmation, signing, and DKG — keep a
monotonic clock ledger: `latestTimestamp` in state, and every time-bearing
event must satisfy `now ≥ latestTimestamp` (typed rejection otherwise;
`abort` carries no clock and leaves the ledger unchanged). A replay of
stale-timestamped events into a restored snapshot is therefore
inadmissible (finding F-12), and the property is checked on *every edge*
of the model-checked state space (§11.2).

---

## 7. Epoch cohorts and batch attestations

Universal confirmation creates a volume problem the dispute-only design
never had: one attestation ceremony per case does not scale to thousands of
settlements per day, and a full DKG per case would make ceremony cost the
dominant expense of *normal* operation. Two mechanisms address this
(v0.8.0): standing **epoch cohorts** amortize the DKG, and **batch
attestations** amortize the signature.

### 7.1 Standing epoch cohorts

An epoch cohort runs the Pedersen DKG (§2.4) **once per epoch** and reuses
the group key across every confirmation in the cohort's validity window.
The cohort record (`epochCohort.ts`) is the publicly verifiable anchor: it
binds the epoch id, cohort index, group pubkey, threshold, roster size,
validity window, and crypto suite into one canonical hash under
`BAO-Court/EpochCohort/v1`, referenced by session parameters, attestations,
and handoff events. Rotation rules are encoded in the module — the rest is
host policy:

- epochs are sequential (`epochId` increments by one);
- a rotation to the *same* group key is rejected — rotation that does not
  change the key is a no-op, not an epoch;
- the new cohort's window must start strictly after the old cohort's window
  started (time moves forward);
- `hashCourtEpochHandoff` (`BAO-Court/EpochHandoff/v1`) binds old cohort →
  new cohort, so any validator can resolve a historical epoch's key from
  the signed handoff chain.

Standing cohorts are capped at 300 participants (201 recommended): the
unanimous-roster DKG rule of §5 step 4 is preserved — the epoch group key
is computed only over a roster whose *every* member's commitment and share
verified.

### 7.2 Batch attestations (kind 39018)

A kind-39018 batch attestation lets **one cohort signature certify an
entire epoch's verdict cohort** (`batchAttestation.ts`):

- **RFC-6962 Merkle tree** over `hashCourtVerdict` leaves, fully
  domain-separated (`BAO-Court/BatchLeaf/v1` leaves, `BatchNode/v1` internal
  nodes), with the RFC-6962 unbalanced split ($k = 2^{\lfloor \log_2(n-1)\rfloor}$)
  so roots are identical across independent implementations; sorted-leaf
  determinism with duplicate rejection; unbalanced-split shape stability;
  at most 10,000 verdicts per batch (bounds tree/proof recursion).
- **Signed manifest** under `BAO-Court/BatchManifest/v1` binding
  (epoch, cohort, batchIndex, count, root, finalizedAt) — the threshold
  signature covers the manifest, and the manifest covers the tree.
- **Inclusion proofs.** Any observer verifies a single case's inclusion
  with an $O(\log n)$ authentication path (`verifyCaseInBatch`) — the
  Merkle fold is negligible (~14 node hashes) and one Schnorr verification
  (~1.3 ms, §11.4) dominates, so per-case verification cost is *flat* from
  10 to 10,000 leaves. Full proof sets are generated in $O(n)$ node hashes
  (v0.10.0; ~450× faster than the naive per-leaf construction at the 10k
  cap, §11.4).
- **Fail-closed validation.** The event validator checks the full Nostr
  serialization (event-id recomputation binds the wrapper), the manifest
  hash, and the root, and returns typed `{valid: false, reason}` for
  tampered or malformed protocol data — only malformed *call arguments*
  throw.

### 7.3 The v2 finality binding

Batch attestations only make sense if a *stale* artifact cannot satisfy
*current* policy. The v2 attestation message
(`BAO-Court/AttestationMessage/v2`, version byte `0x02`) extends the v1
signed message of §3.3 with **in-band finality binding**: `epochId`, `tier`,
`threshold`, `signerSetRoot` (a canonical sorted-index commitment under
`BAO-Court/SignerSet/v1`), optional `attempt`, and optional
`batchMerkleRoot` — carried as Nostr tags *mirrored in content* and bound
into the signed message, so a validator recomputes rather than trusts
them. The dispatcher `validateCourtAttestation` routes on the `epoch` tag
(v2) versus the frozen v1 path, and **refuses the downgrade**: v2-only
finality policy (expected epoch, minimum tier/threshold, signer-set root,
batch root, full signer set with `length === threshold`) requested for a
v1-shaped event fails closed — a stale v1 attestation can never satisfy
policy it never met. Consumers pin policy through the validation context
(`expectedEpoch`, `minTier`, `minThreshold`, `expectedSignerSetRoot`,
`expectedBatchMerkleRoot`, and the group pubkey); a present-but-empty pin
is invalid, never silently disabled (finding F-2). The
**caller-pins-not-the-event** rule is a documented trust assumption, not a
mechanism: an unpinned consumer accepts any valid signature from any group
key, so consumers MUST pin the expected group key — for dispute
attestations, the empaneled cohort's key (§7.1).

### 7.4 Retention and SLA are host-side

The court package contains protocol math only — no storage, no clocks of
its own, no business policy. The operational layers around it are
host-side services built on the court's protocol events and are
deliberately *not* part of this specification: summons/ack SLA tracking
(kind-39008 acks), the retainer-grade composite SLA score (ack rate
discounted by observed participation, so an auto-ack farmer tops out at a
0.5 floor), the append-only juror-pool fee ledger, and the nightly
retention service that batch-deletes terminal bookkeeping rows while never
deleting live deadlines, unacked or unparticipated summons, open SLA
incidents, or the money ledger. The paper treats these as deployment
policy; their correctness obligations (append-only money records,
fail-closed over-debit, network-namespaced epoch ids) are pinned by the
host's own adversarial suite (the round-10 mechanism audit).

**Consumption obligations for the composite (round-16 external review,
finding C-2).** The 0.5 farmer floor is a *cap*, not a pass mark: the
soundness of the composite depends on two host-side obligations that must
travel with every deployment that uses it. (i) **The retainer/retention
threshold MUST be set strictly above 0.5** — at a threshold ≤ 0.5 the floor
is decorative and a zero-participation ack farm passes. (ii) **The
"participation" definition is a pinned host duty** — the composite is only
as game-resistant as the event rule that counts a participation, and
because the metric is linear, published, and monotone, a threshold-sitting
juror will optimize participation to exactly the cheapest clearing rate
(Goodhart). The composite prices *attendance*, not coherence: a juror who
acks and votes in everything but votes wrong keeps SLA 1.0, with wrongness
priced only by the slashing layer when an overturn materializes — that
residual is named rather than closed, and its equilibrium analysis is
registered with PO-1 (docs/REVIEW_SIMULATION.md RS-9).

---

## 8. Escrow lifecycle and slashing

Full specification: `docs/ESCROW-SLASHING.md`. All amounts are integer
satoshis; every function is pure; any observer recomputes the same plan.

### 8.1 Bond ownership proofs

A depositor proves control of the claimed bond UTXO with a BIP-340 signature
over a deterministic, domain-separated challenge:

$$\text{challenge} = H(\texttt{"BAO-Court/BondOwnership/v1"} \;\|\; \texttt{txid} \;\|\; \texttt{vout} \;\|\; \texttt{disputeId} \;\|\; \texttt{jurorPubkey} \;\|\; \texttt{nonce})$$

Binding txid, vout, dispute, juror, and an anti-replay nonce makes proofs
non-replayable across disputes and candidates. Combined with on-chain bond
verification (unspent, amount, script, confirmations), this closes the
"self-attested UTXO" gap: a candidate must *own* the output, not merely name
it.

### 8.2 The ledger

`EscrowLedger` is a serializable state machine per deposit
(`disputeId|purpose|pubkey`):

```
pending ──lock(proofOk)──▶ locked ─┬─▶ returned        (coherent, bond won)
    │                              ├─▶ slashed_50      (incoherent)
    └─(proof rejected)──▶ failed   ├─▶ slashed_100     (non-reveal, double-vote, bond lost)
                                   └─▶ redistributed   (pool transfer executed)
```

Invalid transitions throw; snapshots are JSON-safe. **No sats move inside the
package** — rail execution is the host's (§9).

### 8.3 Redistribution

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

### 8.4 Game-theoretic reading

The design follows the Kleros Schelling-point model [9]: voting with the
eventual majority is the focal strategy, so honesty is incentive-compatible
provided (i) the slash exceeds the bribe a juror can capture, and (ii)
selection is unpredictable (§4). The 50%/100% split distinguishes *wrong*
from *absent or equivocating*: incoherence may be honest error; non-reveal
and double-voting are protocol violations and are priced accordingly.

---

## 9. Settlement rails

Full specification: `docs/SETTLEMENT-RAILS.md`. The court package computes
*what must happen financially*; hosts execute it. The **secrecy boundary is
binding**: this public package contains protocol math, script trees, address
derivation, state machines, adapter contracts, and test fakes — and must
never contain keys, node URLs, credentials, or business policy. Hosts
implement the `LnRail` / `LiquidRail` contracts privately.

### 9.1 Panel A — Lightning hold invoices

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
- **Decisions.** `planDecisionsForHolds` maps the §8.3 plan: coherent /
  bond-won → `settle` (release preimage); incoherent / non-reveal /
  double-vote / bond-lost → `cancel`; unmentioned holds stay `unsettled`
  (host refunds unselected pledgers).
- **Audit.** Settle/cancel audit-event templates never include the preimage —
  only the payment hash.

### 9.2 Panel B — Liquid P2WSH / Taproot escrow

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

### 9.3 End-to-end determinism

Both rails consume the same `RedistributionPlan`, so one verdict drives both
panels without drift. The shipped end-to-end test (and the §11 simulation)
runs: court plan → LN decisions → Liquid branch → skeleton → broadcast,
through in-memory rail fakes, with same-seed reproducibility.

---

## 10. Security analysis

### 10.1 Threat model

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

### 10.2 Attack vectors

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

**L. Stale-artifact replay.** An attestation from an old epoch, an
earlier ladder round, or a round-0 confirmation replayed as final —
satisfying policy it never met. Closed by the v2 in-band finality binding
and the dispatcher's downgrade refusal (§7.3): epoch, tier, threshold, and
signer-set root are inside the signed message, and a v1-shaped event cannot
satisfy v2 policy at all. Pinned by the adversarial validator suite (30
reproduction cases).

**M. Hostile relay data.** Kind confusion (filter drift), tag abuse
(duplicate/nested tags, 100k-mention tags, MB-scale values), NIP-59 seal
games (self-wrapped seals, cross-session replay, algorithm confusion), and
inbox dedupe-key poisoning. Closed by the round-8 adversarial-nostr
hardening: the watcher's resolution outcome is read from the validated,
content-mirrored `outcome` tag bound into the signed message — never from an
unvalidated alias tag a hostile re-publisher could append — and inbox
ingest recomputes the NIP-01 event id before accepting a wrap id, so a
same-id different-content wrap can neither poison the record nor dedupe the
real one away.

### 10.3 Fail-closed invariants (implementation-level)

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
- **Ledger barriers before value moves** — confirmation/outcome ledgers
  re-verified at `resolve_round` and `finalize` (F-3); reveal ledgers
  re-verified before `close_reveals`/`finalize_tally`; signing records
  re-verified on every dispatch, with the signing-session hash re-derived
  (restored snapshots cannot edit outcome/threshold/roster post-hoc).
- **Monotonic clock ledgers** — every time-bearing event satisfies
  `now ≥ latestTimestamp` in all four machines (F-12, §6.4).
- **v2 policy downgrade refused** — v2-only finality policy on a v1-shaped
  event fails closed; an empty policy pin is invalid, never silently
  disabled (F-2, §7.3).

The per-invariant security argument — the formal invariant, its property,
and the literature anchor it rests on — is maintained as the
security-argument skeleton in `docs/CRYPTO_AUDIT.md` §7; §11.5 describes
how the audit program that produced it works as the evaluation methodology.

---

## 11. Reference implementation and verification

This repository *is* the reference implementation: platform-neutral
TypeScript (browser and Node), no UI, no networking of its own, no
persistence — hosts inject clocks, storage, signers, relay pools, and rail
adapters. Module map: `README.md` §10.

### 11.1 Suite, simulation, and adversarial record

- **Suite:** the full vitest suite is green and `tsc --noEmit` is clean
  (source, scripts, and tests are all typechecked). Coverage includes:
  BIP-350 official address vectors, FROST round-trips and
  partial-signature rejection, DKG complaint binding (forged/unattributable
  complaints rejected, genuine grievances disqualify, false complaints
  exonerate), poisoned-backup and negated-share rejection, strict NIP-59
  unwrap, escrow redistribution branches and integrity, LN ledger decisions,
  Liquid script/witness/skeleton correctness, adversarial parser fuzzing,
  the universal-confirmation pipeline and multi-round ladder, batch
  attestation trees/proofs/validators, v2 finality binding, and the
  adversarial machine/nostr/validator suites (§10.2).
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
  (canonical-hashing hardening), `docs/FIXES-2026-08-21.md` (v12 audit, 35
  actionable findings), `docs/COMPLAINT-PROTOCOL.md`,
  `docs/FORMAL_INVARIANTS.md` (the normative invariant reference), and
  `docs/CRYPTO_AUDIT.md` (the cryptographic literature audit).

### 11.2 Exhaustive model checking

Beyond pinning tests, the three ceremony phase machines — vote,
confirmation, and signing — are verified by **exhaustive finite-state-space
exploration**: every reachable state × every event application, asserting
at every step:

- **P1 phase legality** — the phase is always in the machine's declared set;
- **P2 data invariants** — ledger ⊆ roster with unique indices, reveals ⊆
  commits, ballot closure, real SHA-256 commit–reveal / confirmation-hash /
  signing-session-hash re-derivation, real secp256k1 nonce points,
  signer-set freeze == distinct commitment set (A-1), partials ⊆ finalized
  signer set, verdict⇔phase coherence, failure⇔expired/aborted,
  configuration immutability, deep-frozen states, the monotonic clock on
  every edge, and tally re-derivation at terminal phases;
- **P3 no dead ends** — a non-terminal state can reach a non-aborted
  terminal iff it is not one of the machine's own probe-derived parking
  states (biconditional);
- **P4 termination** — the progress graph of legal, state-changing,
  non-abort edges is acyclic (Kahn); idempotent re-applications are counted
  self-loops, not cycles;
- **P5 determinism** — 200 sampled paths per instance replayed from
  creation, twice, byte-identical states;
- **typed-error discipline** — every illegal event application throws the
  machine's *own* error class; any raw `TypeError`/`RangeError` fails the
  instance.

The committed sweep fixture (`__fixtures__/model-check-summary.json`,
regenerable by `npx tsx scripts/model-check.mjs`) covers 13 instances:

| Metric | Value |
|---|---|
| Concrete states explored | **3,145,632** |
| Event applications | **128,522,740** |
| Illegal-event checks (typed rejection exercised) | 68,077,138 |
| Typed throws | 112,076,252 |
| **Raw throws (`TypeError`/`RangeError`)** | **0** |
| Progress edges / idempotent self-loops | 11,716,954 / 4,729,534 |
| Determinism paths replayed | 2,600 (all byte-identical) |

Abstraction limits are stated honestly: explored rosters are small
(n ≤ 3–4, reduced clocks), because the state space grows combinatorially —
but the explored transitions are the machines' *own* reducer code paths, so
the properties are checked on the production guards, not on a model of
them. **Scope note (round-16 external review, finding A-1):** the DKG
machine (`courtDkgMachine.ts`, INV-DKG-1…12) is *not* in the exhaustive
sweep, by design: its peer events carry cryptographic payloads (encrypted
shares, PoKs) whose validity is decided outside the reducer, so state-space
exploration would mostly exercise typed rejection of material the machine
cannot inspect internally; its structural invariants (unanimity,
single-transcript certification, clock ledger, terminal absorption) are
pinned by the invariant/adversarial suites instead, and extending the
explorer to the DKG's structural event space is a registered follow-up
(docs/REVIEW_SIMULATION.md RS-1). Methodology and abstraction limits: the
header of `__tests__/modelCheckingCore.ts`.

### 11.3 Differential parity — the spec-pinning methodology

Every critical pure function of the Court is reimplemented **independently**
— different algorithm, different library, same contract — and asserted to
agree with the production implementation across exhaustive inputs
(`__tests__/differentialParity.test.ts`; reference implementations in
`__tests__/reference/`). A disagreement is *always* a finding: either an
implementation bug or an under-specified contract. The five areas:

1. **CanonicalWriter** — a reference byte-accumulator writer plus an
   independent *parser*: byte-identity, round-trip, prefix-freeness,
   injectivity, boundary + unicode cases, fail-closed ranges.
2. **Batch Merkle tree** — a reference array-slice RFC-6962 builder and a
   record-and-replay proof verifier: exhaustive for n = 1..128, every proof
   verifies, tampered paths reject; the O(n) full-set generator (v0.10.0)
   is pinned to the same reference verifier for n = 1..128, 333, 1000.
3. **Verdict / manifest / attestation-v2 hashes** — `node:crypto` SHA-256
   vs `@noble/hashes`: randomized + boundary agreement.
4. **Selection lottery** — an exact differential on the u32 draw and the
   end-to-end ranking, and a *statistical* differential (chi-square,
   moments, winner law over 100k draws) between the production
   $-\ln(r)/w$ exponential clock and an independent inverse-CDF clock.
   Exact-equal and statistically-equal assertions are documented separately.
5. **Plurality + tie-break** — a reduce-based reference tally vs the
   machine's map loop: exhaustive $3^n$ assignments (n ≤ 4), random big
   tallies, and the UTF-8 (not UTF-16) tie-break divergence pin.

All randomness is seeded (`mulberry32`), so every assertion is
reproducible. The methodology's name is deliberate: the reference
implementations are a readable restatement of the *specification*, so this
suite pins the spec — not the code — and a future rewrite that changes
observable behaviour fails here first.

### 11.4 Performance baseline

Every number below is regenerable by one command (`npm run bench`, with a
machine-readable `--json` twin; methodology and full tables:
`docs/benchmarks/BASELINE.md`). Measurements: `process.hrtime.bigint`, 3
warmup passes, 9 timed samples, median/p95/**min** reported — `min` is the
noise-floor estimator on the shared reference host; a reproducibility pair
agreed within ±20% on 27/29 benchmarks (median deviation 5.8%).

| Benchmark | Params | median | note |
|---|---|---|---|
| `verifyCaseInBatch` | 10 … 10,000 leaves | ~1.3 ms **flat** | O(log n) tree + one Schnorr verify |
| `buildBatchMerkleTree` | 10,000 leaves (cap) | 132.6 ms | linear; max batch cost bounded |
| `buildBatchMerkleProofs` (full set) | 10,000 leaves | ~71 ms total | ~450× vs naive per-leaf (~O(n²)) |
| `validateAttestationEvent` (v1) | kind-39007, supporting=6 | 1.39 ms | Schnorr-verify floor ~1.3 ms |
| `validateAttestationEventV2` | kind-89, ext=6, supporting=6 | 1.31 ms | same floor |
| `reduceCourtSigningMachine` | 10k transitions, roster=threshold=21 | 110 µs | 30× vs pre-v0.10.0 (point-validity memo) |
| `reduceCourtVoteMachine` | 10k transitions, roster=21 | 17.8 µs | |
| `reduceCourtConfirmationMachine` | 10k transitions, roster=3 | 9.5 µs | |
| `selectJury` | roster=10,000 | 32.5 ms | 2.7× vs pre-v0.10.0 |
| `canonicalWriter.encodeHash` | 1,000 field groups | 1.48 ms | 4.4× vs pre-v0.10.0 |

The measured facts the design relies on: **verification scales flat,
batching scales linear** — per-case batch verification is $O(\log n)$ in
the tree plus one signature check, so a 10k-verdict epoch batch costs the
same to verify per case as a 10-verdict one, and the 10k tree build is
bounded and modest. Optimizations never change byte output: the round-9
performance work was pinned byte-identical by the differential-parity suite
before landing.

### 11.5 The audit program as evaluation methodology

The paper's claims were not checked once; they are the output of a
round-by-round program in which each round chooses an attack surface, finds
what it finds, and lands the disposition — a shipped fix with pinned tests,
a documented hold, or a spec'd follow-up — with every finding anchored to a
literature reference, a code location, and an exploitability sketch:

- **Rounds 1–3 (adversarial):** validator/finality scope pins (v0.8.2),
  cross-module state-shape and canonicalization attacks (v0.8.3, v0.8.5),
  and the property sweep that found the mid-ladder dead end (v0.9.1).
- **Formal audit (v0.9.2):** findings F-12 (clock ledgers), F-2 (empty-pin
  fail-closed), F-3 (outcome-history barrier) — `docs/FORMAL_INVARIANTS.md`
  is the normative invariant reference extracted from the actual guards.
- **Model checking (v0.9.3–0.9.4):** the exhaustive sweep of §11.2.
- **Round 7 (literature audit):** `docs/CRYPTO_AUDIT.md` — the
  cryptographic mechanisms *as used*, anchored to FROST/Drijvers, RFC 9591,
  Crites et al. (CRYPTO 2025), ChillDKG/BIP-445, CVE-2025-58359, and
  RFC 6962; §7 of that document is the security-argument skeleton
  (§10.3).
- **Round 8 (differential parity + adversarial nostr):** §11.3 and the
  hostile-relay hardening of §10.2 (vector M).
- **Round 9 (performance):** the measured baseline of §11.4, including the
  *refused* optimizations — recorded with reasons, so the record shows what
  was measured and rejected, not only what shipped.
- **Round 10 (host-side mechanism audit):** economic attacks on the
  implemented incentive rules — ack farming (fixed with the composite SLA
  score), redelivery griefing, cross-network carve replay, dust starvation,
  weight gaming — in the host repository's pinned suite (§7.4).

This is the evaluation methodology a reviewer should apply to the claims of
this paper: not "the authors assert", but "the round that owns this claim
pinned it, and the pin regenerates from one command".

---

## 12. Production gates (honest status)

Implemented and test-covered **in the protocol package**: selection lottery
and verification (stake-weighted and zero-stake reputation modes); Pedersen
DKG with possession-bound complaints; vote, signing, DKG, and
universal-confirmation state machines with the multi-round ladder; monotonic
clock ledgers; attestation formats (v1 frozen, v2 finality binding) and
validation with the fail-closed dispatcher; bond ownership proofs; escrow
ledger and slashing plan; LN and Liquid settlement-rail math; kind-39018
batch attestations and epoch-cohort records; appeal
coordinator/watcher/timing with host-injected transport; NIP-44/NIP-59
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
5. Independent side-channel audit, supply-chain pinning, and a public
   testnet bounty. Differential parity against a *second independent FROST
   implementation* remains open — the differential-parity suite (§11.3)
   covers the Court's own pure functions against in-house reference
   reimplementations; a cross-implementation FROST differential is the
   remaining half of this gate. The upgrade triggers that gate the
   `@vbyte/frost` 1.1.5 pin are documented in `docs/CRYPTO_AUDIT.md` §6.

---

## 13. Conclusion

BAO Court replaces the single-key dispute fallback with a just-in-time FROST
threshold oracle — and, in its v0.8–0.10 form, with a *universal* one:
juries form only when needed (or once per epoch for standing cohorts), no
party ever holds the group secret, every settlement rests on panel evidence
rather than the platform's word, and a verdict is a single ordinary Schnorr
signature — or one signature covering an entire epoch's verdict cohort via
a Merkle batch — that any observer can verify with an $O(\log n)$ inclusion
proof. The economic layer (ownership proofs, escrow ledger, Kleros-style
slashing, flip-flop clawbacks) and the dual-rail settlement specification
(Lightning hold invoices, Liquid script escrow) are deterministic and
publicly recomputable; custody, execution, retention, and SLA policy stay
with hosts. The design is backed by an evaluation methodology, not a
claim: exhaustive model checking of the ceremony machines, differential
parity against independent reimplementations, a regenerable performance
baseline, and a round-by-round literature-anchored audit program (§11).
The remaining work is deployment engineering and independent auditing —
the cryptographic and protocol design is complete, implemented, and
test-backed in this repository.

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
11. RFC 9591 — *Threshold Schnorr Signatures (FROST).* IETF, June 2024.
12. RFC 6962 — *Certificate Transparency.* IETF, June 2013 (the unbalanced
    Merkle-tree construction §7.2 follows).
