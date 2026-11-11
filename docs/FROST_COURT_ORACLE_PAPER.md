# BAO Court: A Just-in-Time FROST Threshold Oracle for Prediction-Market Disputes

**Artifact:** this repository — the reference implementation, its proofs, and
its audit record. Provenance (normative documents, finding codes, artifact
inventory, review record) is consolidated in Appendix A, so that the body
reads as a paper rather than as a changelog.

**Status:** the protocol layers described here are specified and implemented in
platform-neutral TypeScript, and the test suite and typecheck are green. That
is an engineering statement, not a verification verdict: §13 separates — claim
by claim — what is proven, what is machine-checked within stated bounds, what
is empirically evaluated, and what remains an open obligation (PO-*). Rail
*execution*, cross-client ceremonies, and on-chain phase enforcement remain
host-side or pre-production.
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
Liquid P2WSH/Taproot escrow (the *spend* is script-enforced; the *verdict* is
attested-spend bound, i.e. procedurally bound and publicly auditable in v1 —
§9.2) — as pure, host-executed protocol math. The jury forms only when a dispute exists (or, for standing
cohorts, once per epoch), so juror capital is
never locked for the lifetime of a market. The reference implementation is
this repository: platform-neutral TypeScript with a deterministic end-to-end
simulation harness that runs the entire pipeline — selection, DKG, voting,
threshold signing, attestation validation, slashing, and both settlement rails
— in one process with no network. The evaluation methodology is itself part of
the design: line-checked proofs of six core properties, exhaustive
*reachability* model checking of three of the four ceremony machines on bounded
instances (rosters $n \le 4$, reduced clock universes; the DKG machine is
invariant-pinned only) with **witness-aware** probing — 15 instances,
3,869,232 states, 60,020,684 illegal escalation witnesses dispatched, none
accepted — in-house differential
parity over every critical pure function, a regenerable performance baseline,
statistical corpora of 1,187,000 seeded cases / 3,745,566 assertions, a
three-day fault-injected soak of the host pipeline at 30,000 settlements, and a
ceremony run across real OS processes (honestly scoped to one host), plus a
round-by-round cryptographic literature audit. The program also turns on
itself: every round attacks the fixes the round before shipped, and that
re-attack — not an outside reviewer — found three of its own shipped defects
(a bond-free escalation, a durable inbox a 65-relay delivery could brick, and a
ladder bond that priced *membership* rather than *consumption*). §11.6 states
that methodology and §13 labels what it does and does not establish.

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
| **Threshold attestation** | No single party — including the platform — can *produce* a dispute verdict: the verdict is a threshold signature over a group key born in DKG, never held in one place. |
| **Settlement binding** | *Who can release funds once the threshold has spoken.* Three bindings exist and they are not equivalent; v1 is **host-mediated** (the cohort authorises, the host releases — a documented trust point, PO-15). On-chain verdict enforcement (CHECKSIGFROMSTACK on Liquid) is specified there and not yet shipped. |
| **Self-custody** | Winners claim payouts with their own keys; the cohort's signature is never sufficient on its own. |
| **Censorship resistance** | A timelock refund path exists if the dispute oracle stalls. |
| **Privacy** | On the Taproot judge path, on-chain artifacts reveal no threshold structure: one x-only key and one ordinary signature. This does **not** hold for the legacy P2WSH `M`-of-`N` multisig escrow, which publishes `M`, `N` and every participating key by construction (§9.2). |
| **Verifiability** | Jury selection, voting, and attestations are publicly auditable and recomputable. |
| **Availability** | Up to $N-M$ selected jurors may be offline or malicious without stalling signing. Read together with the secrecy bound: fewer than $M$ corrupted jurors reveal nothing about the group key, while $M$ colluding jurors can produce any verdict (§13). |
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
   with the host. The **settlement binding** between a threshold verdict and the
   spend that releases funds is analysed separately (the settlement-binding
   note, App. A, S-1): three achievable bindings, one shipped
   (attested-spend), one specified and gated (CHECKSIGFROMSTACK), and the
   cohort-lifetime constraint that decides whether the key in a judge leaf is
   still alive at resolution.
4. A **reference implementation and whole-court simulation harness** with a
   documented audit record (App. A.5) and an evaluation methodology:
   line-checked proofs, exhaustive model checking, in-house differential
   parity, and a regenerable performance baseline (§11).
5. **Universal confirmation and the escalation ladder** — every outcome
   (disputed or not) confirmed by a juror panel; bond-witnessed challenges;
   a ×3-per-round mass-vote ladder with flip-flop clawback flags and an
   append-only outcome history (§6).
6. **Epoch cohorts and batch attestations** — one DKG and one threshold
   signature per epoch cohort, certifying a whole verdict cohort through an
   RFC-6962 Merkle batch with in-band finality binding (§7).
7. **A self-attacking assurance case** — the verification program treats its own
   fixes as attack surface. Each round re-derives the threat model against the
   code the previous round shipped, grades a finding `EXPLOITABLE` only when a
   test demonstrates the harm, and re-runs the whole battery on the next head.
   It has found its own exploits (r29-1: the escalation bond was bound to the
   case rather than the challenger), its own operational brick (T-1: a 65-relay
   delivery made a durable inbox unrestorable), and its own economic hole
   (r30-1: the ladder bond was a membership test, so escalation was a free
   option) — and its own **stale evidence** (SOAK-F8: the soak had been silently
   red on `main` for two protocol rounds). §11.6 names the method and its
   limits; §13 keeps it in the evidence taxonomy rather than treating it as a
   verdict.

### 1.5 Related work

BAO Court sits between two families: *oracle designs* that put an outcome on a
Bitcoin-family rail, and *dispute systems* that decide an outcome by a panel.
Table 1 compares the obvious neighbours on the axis that matters for each —
what the neighbouring system already gives you, what this design adds on top of
it, and where the neighbour is simply better than what we have shipped. The
last column is deliberately unflattering: every row names at least one property
the neighbour has and BAO Court does not.

**Table 1. Related systems, and the honest comparison.**

| System | What it provides | What BAO Court adds | Where it is better than BAO Court |
|---|---|---|---|
| **Discreet Log Contracts** (Dryja [13]) | A Bitcoin-native oracle design: the oracle pre-commits a nonce, publishes one signature per outcome, and pre-signed contract-execution transactions are selected by that signature. No on-chain oracle footprint. | The *oracle authority itself* is threshold and ephemeral: an $M$-of-$N$ FROST group born in a per-dispute DKG, no party ever holding the key, with the signed message bound to a public tally commitment. The outcome is decided by a jury, not by a named oracle. | **On-chain verdict enforcement is native to DLC**: the chosen execution transaction is checked by script, so no release step is trusted. v1 here is host-mediated (PO-15). DLC tooling is more mature, and a DLC oracle learns nothing about the contract it serves. |
| **UMA optimistic oracle** [14] | Bond-backed assertion + liveness window + escalation to a token-holder dispute vote. A cheap path for undisputed assertions, deployed in production. | Cryptographic finality: the verdict is one ordinary BIP-340 signature under a group key, verifiable by any Bitcoin/Liquid/Lightning stack, plus verifiable lottery selection of the deciding panel and a verdict commitment over the public vote ledger. | **No panel is needed at all** for an undisputed assertion — a liveness window suffices, so UMA has no ceremony-liveness requirement and no per-outcome signing cost. It is live, and its integration surface is far smaller. |
| **Augur** [15] | Staking-based reporting with dispute rounds, and a fork as the ultimate social backstop. | A threshold signature as the verdict artifact (portable to non-Ethereum rails), deterministic and publicly recomputable escrow/slashing math, and a bounded escalation ladder instead of a global fork. | The **fork is a stronger backstop** than a bounded ladder: it cannot be captured by a minority that the ladder's final round happens to favour. Augur is also a full market stack, not only an oracle. |
| **Chainlink OCR** [16] | Off-chain reporting for a node committee: threshold-signed reports, leader change, and production-level throughput engineering. | An **adversarial** selection and accountability layer around the committee: the panel is drawn per dispute by public lottery, and incoherent members are slashed. OCR's committee is permissioned and assumed honest-majority. | Engineering maturity and operational track record at feed scale; OCR is deployed, monitored, and benchmarked far beyond this work. |
| **ROAST** (Ruffing et al. [17]) | Robustness for FROST *signing*: a coordinator plus retry rounds guarantee a signature whenever any $t$ honest signers are reachable, even under asynchrony. | Accountability around signing — roster-bound votes, slashing, public attestations, and an economic layer — plus a jury semantics. ROAST is a signing protocol only. | ROAST **proves a liveness guarantee we do not have**. Here, signing requires $\ge M$ responses inside the window; otherwise the attempt is reselected or refunded (§5, §10.2 I). A ROAST-style coordinator is the natural next step for that obligation. |
| **Kleros** [9, 18] | A Schelling-point juror court: staked jurors, appeal rounds, coherent-juror rewards, and years of live operation. | A **cryptographic verdict** (threshold Schnorr) instead of an on-chain court contract, so one attestation format settles on Bitcoin, Liquid and Lightning rails; deterministic, integer-only slashing plans; batched epoch attestation. | A published evidence standard, a live appeals market, and a much deeper analysis of juror incentives than the sketch in §8.4. |

Beyond the row-by-row comparison, three combinations are, as far as we know,
not offered by any single system above: **(i) a standing-cohort universal
confirmation** — every outcome, disputed or not, carries panel evidence, with
one epoch cohort amortizing the DKG; **(ii) batched attestation** — one
threshold signature certifying an entire epoch's verdict cohort through an
RFC-6962 Merkle batch with in-band finality binding (§7); and **(iii) the
protocol-and-artifact pairing** — the specification, the machine-checked
reference implementation, and this paper's claims are intended to be checked
against each other, with a provenance appendix (App. A) that says where each
claim's evidence lives. None of those three is a strength in itself if the
verification is taken on trust; §13 states exactly how far each is established.

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
ceremony hardening; the complaint-protocol note, App. A, S-2):

> Only the recipient of an actually-received encrypted share may complain
> about it, and the complaint event must be signed by that recipient and
> anchor the accused's share event.

**What an outsider learns, and why possession binding caps it.** A VSS defense
is public, and it publishes an evaluation point of the accused dealer's
polynomial. An outsider who reads the ceremony transcript therefore accumulates
points of honest dealers' polynomials; $t$ points of one dealer's
degree-$(t-1)$ polynomial interpolate that dealer's secret contribution, and $t$
such extractions recover the group key. The attacker never needs a share — only
the *public* transcript. So the security question is how many defenses one
coalition can force into that transcript. Without possession binding, anyone
may file complaints "on behalf of" arbitrary victims, and $m$ colluding parties
can force $t$ defenses against one honest juror at zero cost — enough for the
outsider to interpolate. With possession binding, a complaint must be signed by
the recipient that actually received the share, and each colluder controls
exactly one recipient index; a coalition of $m$ parties can therefore put at
most $m$ points of any honest dealer's polynomial into the public transcript,
so under the honest-majority condition $m + 1 \le t$ the outsider stays
strictly below the interpolation threshold. The same binding removes the
zero-cost ceremony DoS (forged complaints that disqualify honest jurors at no
cost to the attacker).

### 2.5 Encrypted transport

Private protocol messages (shares, complaints, backups) are carried as
NIP-44 v2 [5] encrypted payloads inside NIP-59 gift wraps [6]; unwrap paths
verify the recipient tag, the seal's Schnorr signature, seal-author equality
with the rumor author, and recompute the rumor id (the strict-unwrap
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

- **Path A — normal.** Primary-oracle attestation **and** winner signature
  (host-mediated: the oracle co-signs the spend against its own resolution
  record).
- **Path B — dispute.** FROST attestation under the cohort's group key, then a
  **second** signing session in which that same key signs the *spending
  transaction*; the script requires the winner's signature as well:

  ```
  judge  : <winner> CHECKSIGVERIFY <group> CHECKSIG      (attested-spend)
  refund : <T> CLTV DROP <funder> CHECKSIG
  ```

  The on-chain signature is over the taproot sighash — **not** over the
  attestation message. Binding the verdict to the spend is therefore
  *procedural* in v1: the cohort contributes a spend signature only against a
  valid published attestation whose plan it can reproduce, and every
  `(attestation, planHash, sighash, txid)` tuple is published so the binding is
  auditable. The platform therefore **is** a trust point for release (never for
  the verdict). On-chain verdict enforcement needs CHECKSIGFROMSTACK and a
  creation-time settlement commitment; it is specified, gated, and not shipped.
  See the settlement-binding note §2 (App. A, S-1) for all three bindings, side
  by side.
- **Path C — refund.** After absolute timelock $T$, the funder reclaims.

The conjunction in Path B still says something important — **the cohort cannot
redirect the money**: a threshold signature without the winner's key spends
nothing, and the cohort's signature commits to one exact transaction. What it
does *not* say is that the verdict is checked by consensus. Whoever validates
the attestation before requesting the spend signature is part of the trust base.

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

This is a **Nostr message, not a transaction signature**. It proves the verdict;
it cannot by itself move funds (a tapscript `OP_CHECKSIG` verifies a sighash, and
no shipped script verifies an attestation — settlement-binding note §1). The
spend is authorised by a *second* signing session under the same group key whose
message is the sighash.

Each field is UTF-8 **length-prefixed** under a domain tag
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
signed message, so the FROST signature certifies **the tally that produced the
outcome**, not just the outcome: an attestation for an outcome that lost the
vote is **publicly detectable** rather than merely suspicious. The signature is
not malformed — it is a valid Schnorr signature over a message that commits to a
tally — so detection is by *recomputation*, and the procedure is public: any
observer re-runs the tally from the published reveal events, recomputes
`verdictHash` under the same domain, recomputes $m$, and compares both against
the `verdict` tag and the signed message. A mismatch means the signers certified
a tally that no honest reveal set produces. What the binding buys is
auditability, not prevention: the signers can still sign a false commitment, and
only the recomputation catches it — which is why the reveal ledger, not the
signature, is the evidence. The supporting reveal event ids ride as
`e`-mention tags, so the recomputation above needs nothing beyond the
attestation itself. The wrapper event
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
window. The cohort key is an oracle key only (§3.2) — it authorises, it never
redirects — cohort members are escrowed and slashed under the same ledger
rules (§8), and rotation is enforced by the signed handoff chain — a stale
cohort cannot outlive its validity window (§7.3).

**The cohort is the only key that can be in a judge leaf.** A JIT dispute key
does not exist at market creation, so a script cannot name it
(settlement-binding note §1.2). That forces a lifetime constraint that is
easy to get wrong: *the market window must fit inside the cohort's epoch* —
formally `resolveBy + settlementSlack ≤ cohort.endsAtSec` — because rotating the
cohort destroys its shares and a script-bound escrow cannot follow the
handoff chain. The market-creation rule and the refusal / shorten /
pre-commit-next-cohort policy ladder are in the settlement-binding note §3.

---

## 4. Jury selection

### 4.1 Seed

$$\mathrm{seed} = H(\texttt{disputeEventId} \;\|\; \texttt{blockHash})$$

where `blockHash` is a confirmed Bitcoin block hash (default: 6
confirmations): publicly observable, unpredictable before mining, and
infeasible to bias without a deep reorg. The selection event publishes the
exact seed and block hash used, so **anyone recompute the draw**
(`verifyJurySelection`) — selection is a proof, not a claim.

Two ordering requirements, and their residual (the economics gap-fills note,
App. A, S-15, §4): **(a)** the seed block **height** must be *derived* from the
candidate-set
freeze height ($h^{*} = h_{\text{freeze}} + \Delta$ with $\Delta \ge 6$), never
selected after a hash is visible — otherwise whoever picks the height picks the
jury; **(b)** the candidate set must be committed before the seed exists. The
irreducible residual is the tip-block option: the miner of block $h^{*}$ can
compute the panel and withhold at the cost of one block reward, so a re-draw is
viable only for disputes above $R_{\text{blk}}/\Pr[X = t-1]$ — in the most
attacker-favourable shipped configuration (45-seat panel, 49 % weight share) that
is $\approx 223$ BTC, i.e. two orders of magnitude above any BAO market. A
$k$-block beacon narrows who can attempt it ($\beta_{\text{mine}}^{\,k}$) but does
not remove the tip's one-block option.

### 4.2 Stake-weighted quadratic lottery

For each eligible candidate $j$ with stake $w_j$:

$$r_j = \frac{\mathrm{uint32BE}\big(H(\mathrm{seed} \| \mathrm{pubkey}_j)\big)}{2^{32}}, \qquad \pi_j = \frac{-\ln r_j}{\sqrt{w_j}}$$

The jury is the $N$ candidates with the **smallest** $\pi_j$; exact ties break
by pubkey ascending (insertion-order independent, fully reproducible).

**Reconciliation with the code — three details the formula hides.** (i) The
stake path evaluates $\pi_j = -\ln(r_j)/\sqrt{\max(1, w_j)}$: the $\max(1,\cdot)$
floor stops a zero-stake candidate from producing an infinite priority, and it
is the only structural difference between the formula above and
`quadraticPriority`. (ii) The optional reputation mode of §4.4 replaces
$\sqrt{w_j}$ with a caller-supplied
weight $w_j$ and evaluates $\pi_j = -\ln(r_j)/w_j$ (`weightedPriority`) — the
same exponential clock, a different rate function; the paper's $\sqrt{w_j}$ is
the *stake default*, not the general case. (iii) $r_j$ is clamped away from the
boundary before the logarithm ($r \le 0 \mapsto$ the smallest positive double,
$r \ge 1 \mapsto 1-\epsilon$), so no priority is ever infinite or NaN.

**The draw is 32 bits wide, and $\ln$ is engine-defined.** Two consequences,
stated because they bound the reproducibility claim. First, with $2^{32}$
values, distinct candidates can share an $r_j$; the deterministic pubkey
ordering of the tie-break is what makes the outcome well defined, and a
collision is visible in the published selection event. Second, $-\ln$ is
evaluated in IEEE-754 double precision, and ECMAScript does not require
bit-identical `Math.log` results across engines, so a near-tie can in principle
be ordered differently by two conforming engines. The first four bytes of each
candidate's SHA-256 digest — the input to $r_j$ — are exactly reproducible, so
such a divergence is *detectable* by recomputation — but bit-exact cross-engine
ordering is not established, and we register it as an open obligation (PO-17)
rather than claim cross-engine determinism.

**Proposition (exponential race).** *For uniform independent $r_j \in (0,1)$,
the first $N$ order statistics of $\{\pi_j\}$ sample candidates without
replacement with per-draw probability proportional to $\sqrt{w_j}$.*

*Proof sketch.* $-\ln r_j \sim \mathrm{Exp}(1)$, so
$\pi_j = (-\ln r_j)/\sqrt{w_j} \sim \mathrm{Exp}(\sqrt{w_j})$. The minimum of
independent exponentials is won by $j$ with probability
$\sqrt{w_j} / \sum_k \sqrt{w_k}$; the race repeats memorylessly for each
subsequent rank — precisely sampling without replacement at rates
$\sqrt{w_j}$. ∎

Quadratic weighting makes a **single identity's** selection probability
concave in its own stake: a juror with $4\times$ stake is only $2\times$ as
likely to serve. That is a real price on *concentrated* capital, but it is not
a price on *partitions* of it. A capital holder who splits $w$ across $k$
eligible identities has aggregate weight $k\sqrt{w/k} = \sqrt{k}\sqrt{w}$ —
exactly a $\sqrt{k}$ gain for the same capital — and because the
$1\%$-of-volume eligibility floor (§4.3) caps $k$ at
$\lfloor w / 0.01V_m \rfloor$, the achievable weight at that ceiling,
$w/\sqrt{0.01V_m}$, is **linear** in stake. Quadratic weighting is therefore
anti-plutocratic only while identities are indivisible; **the Sybil price is
carried by the admission filters of §4.3** (web-of-trust score, account age,
confirmed stake commitment, category match), whose per-identity cost is
non-purchasable, not by the exponent. Exponents are a transaction cost on
splitting; the filters are the defence. Full derivation and the corrected
statement: the economics gap-fills note (App. A, S-15, §5).

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

**What commit–reveal buys, precisely.** It stops *copying*: commitments are
binding, so a juror cannot wait to see the emerging majority and herd into it.
It does not stop *buying*: a briber who pays for a chosen outcome can verify
compliance from the reveal, and no phase structure prevents that. Vote buying is
therefore priced by the slashing layer (§8) and made observable by the public
reveal ledger — not prevented by the commitment scheme.

---

## 6. Universal confirmation

The dispute pipeline of §5 covers the *dispute* path only — the
overwhelming majority of markets, those nobody disputes, would otherwise
rest solely on the platform's primary-oracle attestation. Universal
confirmation (the universal-confirmation design proposal, App. A, S-3) closes
that gap: **every market outcome — disputed or not — is confirmed by a juror
panel**, so the court produces positive evidence for every settlement and the
primary oracle becomes a proposal the panel can uphold or overturn, not an
unappealable fiat.

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
- **The confirmation quorum defaults to the roster supermajority.** The
  factory's `confirmQuorum` default is $\lceil 2N/3 \rceil$ (4-of-5, 10-of-15,
  30-of-45, 90-of-135) — not 1. A host may configure a smaller quorum (the
  shipped 3-of-5 rollout is such a policy), and the machine then records
  `quorumBelowSupermajority: true` in its state so a policy layer can gate on
  it. The capture cost of both choices is tabulated in App. A, S-15, §1.3: the
  one-confirmation default captured most of the time at every plausible
  adversary weight share, and the shipped 3-of-5 captures several times more
  often than the $\lceil 2N/3\rceil$ standard the threat model names.
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
  indices (the barrier is pinned by the ledger-restore finding recorded in
  App. A.3).
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
caps the round count. Escalation is **explicit, and the caller is whoever the
deployment authorises**: after a non-final round resolves, the machine parks in
`round_resolved`, where a caller plays `escalate` (next round) or `concede` (the
current outcome becomes final) — the machine never auto-escalates and never
auto-concedes.
`open_ladder_round` may carry an expanded per-round roster (a superset of
the previous round is *not* required); mass votes validate against the
round panel, and round rosters re-verify at the close/resolve ledger
barrier. **In the host deployment, escalation is not the operator's to
grant.** The confirmation spec makes `escalate` a **bonded
challenger's right** (ESC-RIGHT-1…5): while the challenger's window is open
the host may neither escalate nor concede, and operator discretion is
break-glass only (`BAO_COURT_HOST_ESCALATION`, default off). **The protocol
machine now verifies that authorisation itself** (INV-ESC-1…9,
`docs/FORMAL_INVARIANTS.md` §5.9): `escalate` carries an authority witness
(`authority`, `challengerIdx`, `challengerPubkey`, `requestHash`,
`bondProofHash`, `roundIndex`, and — since v0.13 — `roundBondProofHash`), and
the reducer — not the host API — refuses an unwitnessed escalation, a witness
for any round other than `ladderRound + 1`, a challenger outside the case
roster, a bond hash the case never accepted, a bond hash accepted from a
*different* challenger, a host escalation outside the frozen break-glass
policy, and (on a case created with `requireRoundBond`, default **off** for
compatibility) a rung that arrives without its own consumed bond. The accepted
witness is appended to `escalationLog`, which `finalize` re-verifies
(INV-ESC-8). A host that bypasses its own endpoint therefore no longer holds the
appeal power. Two properties of the ladder are *economic*, not structural, and
are specified separately: the challenge bond is a **consumption** test per
round, not a membership test (v0.13.0, §8.4), and the ladder depth a deployment
may price is derived from its measured accuracy rather than chosen
(`deriveMaxLadderRounds`, §8.4). What remains open is
the symmetric witness on `concede` (the challenger's own signed concession,
ESC-RIGHT-3), which v1 still leaves to the host API.

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
inadmissible (the clock-ledger finding recorded in App. A.3), and the property
is checked on *every edge* of the model-checked state space (§11.2).

---

## 7. Epoch cohorts and batch attestations

Universal confirmation creates a volume problem the dispute-only design
never had: one attestation ceremony per case does not scale to thousands of
settlements per day, and a full DKG per case would make ceremony cost the
dominant expense of *normal* operation. Two mechanisms address it: standing
**epoch cohorts** amortize the DKG, and **batch attestations** amortize the
signature.

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
  10 to 10,000 leaves. Full proof sets are generated in $O(n)$ node hashes —
  about 450× faster than the naive per-leaf construction at the 10,000 cap
  (§11.4).
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
is invalid, never silently disabled (the empty-pin finding, App. A.3). The
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
host's own adversarial suite (the host-side mechanism audit).

**Consumption obligations for the composite.** The 0.5 farmer floor is a
*cap*, not a pass mark: the soundness of the composite depends on two host-side
obligations that must travel with every deployment that uses it. (i) **The retainer/retention
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
registered as PO-1 (RS-9 in the review register, App. A, S-6).

---

## 8. Escrow lifecycle and slashing

Full specification: the escrow-and-slashing note (App. A, S-4). All amounts are
integer satoshis; every function is pure; any observer recomputes the same plan.

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

**The escalation bond is a consumption test, not a membership test.** A witness
is a structural guard; it says nothing about what the ladder *costs*. The
economic re-verify of the post-fix layer found that v0.12's witness admitted any
bond the challenger had ever posted, so one payment authorised every rung
($\Delta C_{r+1} = 0$ for every $r$) — escalation was a **free option** worth
$\sum_{r} 3^r b_0 = 363\,b_0$ at the protocol cap. Measured: the unmerited
challenger's burn fell from −2.40 % to −1.86 % of $V$ at the shipped cap
($R = 2$) and to −0.543 % at the protocol cap ($R = 5$, i.e. 77.4 % of the
deterrence gone), and the venue-cost ÷ griefer-loss ratio rose from 0.86× at
$R = 2$ to 54.1× at $R = 5$ ($c_s = 500$). v0.13.0 makes the bond a **consumption**
test: the witness carries `roundBondProofHash`, the reducer refuses a missing
per-round bond on a strict case (`requireRoundBond`, default off so existing
cases keep v0.12 semantics), a relabelled membership bond, and a hash an earlier
round already consumed, and `assertValidEscalationLog` re-derives all three
rules at `finalize` so a restored snapshot cannot re-open the option
(INV-ESC-9; App. A, S-18). The price curve is the specification's
$\Delta C_R = 3^R b_0$ on top of the challenge bond — cumulative
4 / 13 / 40 / 121 / 364× at $R = 1..5$ — and *the amounts stay host policy*,
which the machine cannot see.

**The ladder cap is derived, with a flip-round subtlety.** A deployment's
admissible depth is a function of its measured accuracy, not a preference:
`deriveMaxLadderRounds({a_f, ρ, β})` computes
$\lfloor \ln(\rho/(\rho+\beta)) / \ln a_f \rfloor$ and clamps it to the machine
ceiling (5) — 6 / 4 / 2 at $a_f = 0.90 / 0.85 / 0.75$, hence 5 / 4 / 2 once
clamped. `deriveLadderFlipRound` returns the first round that is *profitable* to
challenge (7 / 5 / 3 at the same accuracies), which is exactly **one above** the
safe bound: alerting on the flip round is one round late, so the cap must be
derived from the safe bound and the flip round used only as an alert. Both
functions are pure, published, and pinned to the numbers of the economics
re-verify (App. A, S-21 §1.5).

**Two corrections the re-verify forced, in opposite directions.** (i) The brief
that prompted it assumed a weaker-than-supermajority confirm quorum *loosens*
the economic cap. It does not: the cap of the gap-fills note is the $\pi = ½$
slice of a family $V_{\max}(\pi)$, and a weaker quorum **tightens** it by
$\kappa_q = 2.75$–$4.64$ — so the correction is slack, not exposure (r30-3,
**SAFE**, premise corrected). (ii) A frozen ladder configuration is a *ceiling*,
not a guarantee: the panel a cohort can actually seat is
$\min(N_{\text{cfg}}, \text{drawable})$, and a 135-seat configuration churned to
45 seats is **2.47× short** of its own invariant, its honest cap falling to
101,250 sats (r30-2). The host closes it by re-deriving the cap at the
effective $N$ and refusing deposits/escalations that breach it while never
blocking a concession (`min(cap at creation, cap effective now)`; the
quorum-aware table tightens a 45-seat cap to 21,838 sats at a 3-of-5 quorum —
host PRs #2413, #2417). Decay pairing (r30-4) is the same shape of correction:
idle decay replaced a reset cliff with a ramp that dominates the cliff's average
at every cycle (+26.0 % at 6-of-6), so idleness is *cheaper*, not free —
`penaltyAging.ts` anchors the decay at the floor and prices recovery with
participation. None of these is a protocol-safety finding; all are the
incentive layer doing its job under measurement rather than assertion.

---

## 9. Settlement rails

Full specification: the settlement-rails note (App. A, S-5). The court package
computes *what must happen financially*; hosts execute it. The **secrecy
boundary is
binding**: this public package contains protocol math, script trees, address
derivation, state machines, adapter contracts, and test fakes — and must
never contain keys, node URLs, credentials, or business policy. Hosts
implement the `LnRail` / `LiquidRail` contracts privately.

### 9.1 Panel A — Lightning hold invoices

Lightning cannot script-enforce a penalty, so Panel A implements *social
slashing*: coherent jurors get paid, incoherent jurors get nothing.

- **Deterministic preimage.**
  $\text{preimage} = H_{\text{dom}}(\texttt{disputeId} \| \texttt{role} \| \texttt{pubkey} \| \texttt{outcome} \| \texttt{attestationDigest} \| \texttt{round})$
  under domain `BAO-Court/LnPreimage/v1`. The payment hash is `SHA-256` of the
  **raw preimage bytes** (BOLT semantics).
- **The preimage is not a secret, and we do not claim it is.** Every input to
  the hash is public once the reveal window closes: `disputeId`, `role`,
  `pubkey`, `round`, the outcome, and the attestation digest (itself
  recomputable from public fields, §3.3). There is **no secret input**, so any
  party can derive any hold's preimage. The property this gives is *ordering*,
  not confidentiality: a preimage cannot exist before the verdict it is bound
  to. The property it does **not** give is forfeiture: if a hold is still
  `held` when an incoherent juror's preimage becomes derivable, anyone can
  release it and the juror is paid, whatever the §8.3 plan says. Panel A is
  therefore *social* slashing in the strong sense — the penalty is the host's
  refusal plus the slashing ledger, and a settle contrary to the plan is a
  publicly attributable event (the released preimage matches the published
  witness), not a prevented one. Closing the gap needs either a host-held
  secret in the witness — which makes the host the custodian of every slashing
  claim — or a script-enforced rail (Panel B). Registered as PO-16.
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

Panel B enforces the **spend** in script (threshold, destination, timelock); the
verdict reaches it through the cohort's attestation and, in v1, the host's
release step:

- `OP_<M> <pk_1> … <pk_N> OP_<N> OP_CHECKMULTISIG` P2WSH escrows (1–15 keys;
  x-only inputs lifted to compressed with correct parity; the standard
  `OP_FALSE` witness bug element). This shape **publishes** `M`, `N`, and every
  participating key in the redeem script; the privacy property of §1.2 is a
  property of the Taproot judge path only, and the two escrow shapes must not
  be described interchangeably.
- Taproot judge/refund trees: a judge leaf
  `<winner> CHECKSIGVERIFY <judge> CHECKSIG` and a CLTV refund leaf. The judge
  slot holds the **standing cohort** key and the signature it verifies is over
  the spend's taproot sighash — an *attested-spend* binding, not an on-chain
  attestation check (§3.2, settlement-binding note). `buildCourtJudgeLeaf`
  serializes this leaf and refuses a shared winner/judge key;
  `buildTaprootLeaves` remains the byte-compatible single-oracle builder.
- BIP-173/BIP-350 address derivation (bech32 v0 / bech32m v1; the witness
  version is a 5-bit word prepended to program words — byte-concatenation
  would silently corrupt it, covered by tests), BIP-341 tweaked programs with
  even-Y parity correction, sorted-pairs Taproot merkle trees.
- `buildReleaseSkeleton`: fee-exact, integer-only transaction skeletons with
  dust guards; `assembleMultisigWitness` for the M-of-N spend.

The script does not read the tally — the court's plan decides **which branch
to sign**, and the public builders construct exactly the transaction that
realizes the court's decision. Nor does it read the attestation: a Liquid
`CHECKSIGFROMSTACK` leaf that would verify the verdict on-chain is specified in
the settlement-binding note §2.2 and is **not** shipped (it needs a
consensus-tested opcode, a creation-time settlement commitment, and one leaf
per outcome).

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

**The two bounds, stated together.** Corrupting fewer than $M$ jurors yields no
verdict: fewer than $M$ shares carry no information about $f(0)$ and fewer than
$M$ partial signatures never aggregate (§2.3). Losing up to $N-M$ jurors yields
no stall: any $M$ of the $N$ can sign. The design is $M$-of-$N$ on *both* axes,
and the two numbers are not interchangeable — $M$ is the corruption budget for
soundness, $N-M$ is the fault budget for liveness. Raising $N$ with $M$ fixed
weakens collusion resistance; raising $M$ toward $N$ weakens liveness. §13
restates both bounds, with their evidence, as separate claims.

**Assumptions.** (A1) The one-more discrete-log hardness underlying FROST [1]
and the random-oracle model for $H$; (A2) at least $M$ honest jurors opt in
and participate; (A3) honest jurors share authenticated, encrypted channels
(§2.5); (A4) for the complaint bound of §2.4, an honest majority in the
corruption sense $m+1 \le t$; (A5) the block-hash seed is unbiased at the
required confirmation depth; **(A6) the settlement binding** — the release path
either (a) runs a spend-signing session whose participants enforce the
attestation and the plan (attested-spend, §3.2), or (b) verifies the verdict in
script (CHECKSIGFROMSTACK, specified but not shipped), or (c) is a *named*
trust point whose operator is inside the threat model. A6 is **not** discharged
by the FROST signature itself: a threshold signature over an attestation
message says nothing about what happens to the escrow (the settlement-binding
note §5 keeps the open items, PO-15).

**Prototype deployments satisfy none of A2–A4 by construction** (single-process
ceremonies), and **A6 is discharged by (c) today** (host-mediated release); see
the honest status section of the README.

**The host as an adversary (explicit).** In the shipped v1 the platform is a
release authority, not merely an executor:

| Capability | Cryptographically prevented? | Control |
|---|---|---|
| Fabricate a verdict | yes — needs $M$ shares | threshold |
| Alter an attested outcome | yes — the validator recomputes the tally commitment, market id, outcome whitelist and signature under the pinned group key | validator |
| Move escrow funds to an arbitrary destination | yes — the cohort signature commits to one sighash and the winner must also sign | two-signature leaf |
| **Release with no verdict at all** | **no** | none at the signer; post-hoc audit (§9.2) |
| **Choose among several valid verdicts** | **no** | one attestation per `(market, round)`, monotone round, published trail |
| Refuse to release (censorship) | — | CLTV refund path |

Authority confusion — "the court approved this" when in fact "the host asked for
a signature" — is the failure this table makes impossible to state by accident.

### 10.2 Attack vectors

**A. Single rogue juror.** One Shamir share gives no information about
$f(0)$ (perfect privacy of Shamir sharing [2]); forgery needs $M$ shares.
*Mitigated by the threshold.*

**B. $M$-of-$N$ collusion.** $M$ colluders can sign any outcome. Raised cost:
$M \approx \lceil 2N/3 \rceil$ with unpredictable selection; public
commit–reveal voting makes collusion observable; slashing punishes
overturned attestations; the dual-panel design forces compromise of both
rails' evidence trails. **Honest scope on the economic half:** the slashing
that gives the bribery bound its teeth is the **Liquid escrow panel's**
seizable on-chain stake. The **Lightning panel's** sanction is denial of the
reward plus reputation — *social* slashing — which seizes no capital, so a
bribery bound expressed as "colluders risk their stake" holds on Panel B and
not on Panel A; there the resistance is coordination cost and detection, and
the operator must cap the values it routes to that rail
(the economics gap-fills note, App. A, S-15, §2.2–2.5).

**C. Censorship / oracle stall.** The refund path (Path C) activates after
$T$. *Mitigated by construction.*

**D. Key theft.** No single secret exists; the adversary must steal $M$
independent juror keys. Proactive refresh (share re-randomization) further
bounds the value of stale shares: the independent-DKG session produces a
refresh commitment and encrypted refresh shares per peer, recomputes the
verification shares against the *unchanged* group key and *unchanged*
threshold, and throws if either would move. (Refreshing with a smaller
threshold is a known implementation error class — the ZF-FROST vulnerability
record [20] — so the invariant is asserted, not assumed.) Refresh is a
per-session operation, not part of the epoch rotation of §7.1, which re-runs
the DKG instead.

**E. Front-running.** The attestation alone cannot spend — the winner's key
is required (§3.2), and the cohort's own signature commits to one exact
sighash. The host, however, can *choose* which verge of the flow runs: see
§10.1's host-adversary table.

**F. Sybil / stake concentration.** Quadratic lottery (§4.2) priced against a
*single* identity's stake; the load-bearing Sybil price is the admission
filter set of §4.3 (WoT, account age, confirmed pledge). Honest scope: with
splitting to the $1\%$-of-volume floor the achievable weight is linear in
stake, so the exponent is a transaction cost on splitting, not a plutocracy
bound (the economics gap-fills note, App. A, S-15, §5).

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

**K. Complaint forgery / forced share disclosure.** Closed by possession-bound,
victim-authored complaints (§2.4): group-secret extraction via forced defenses
and zero-cost ceremony DoS are both eliminated under $m+1 \le t$.

**L. Stale-artifact replay.** An attestation from an old epoch, an
earlier ladder round, or a round-0 confirmation replayed as final —
satisfying policy it never met. Closed by the v2 in-band finality binding
and the dispatcher's downgrade refusal (§7.3): epoch, tier, threshold, and
signer-set root are inside the signed message, and a v1-shaped event cannot
satisfy v2 policy at all. Pinned by an adversarial validator suite of
reproduction cases (App. A.4).

**M. Release without a verdict (authority confusion).** The host holds the
signer credential and the settlement binding is procedural in v1, so a
compromised or misdeployed host can obtain the cohort's spend signature for a
transaction no verdict authorises — and can select among multiple valid
verdicts. *Not mitigated cryptographically today.* Controls: two-signature
leaves (the winner must also sign), one-signature-per-`(kind, escrow, rail,
action, planId)` at the signer, and the published
`(attestation, planHash, sighash, txid)` tuple that makes every release
re-checkable after the fact. The fix is a signer that requires the attestation
in the signature request (settlement-binding note §4.2), and — for Liquid
binary/escrow rails — the CHECKSIGFROMSTACK leaf (§2.2).

**N. Hostile relay data.** Kind confusion (filter drift), tag abuse
(duplicate/nested tags, 100k-mention tags, MB-scale values), NIP-59 seal
games (self-wrapped seals, cross-session replay, algorithm confusion), and
inbox dedupe-key poisoning. Closed by the hostile-relay hardening: the
watcher's resolution outcome is read from the validated,
content-mirrored `outcome` tag bound into the signed message — never from an
unvalidated alias tag a hostile re-publisher could append — and inbox
ingest recomputes the NIP-01 event id before accepting a wrap id, so a
same-id different-content wrap can neither poison the record nor dedupe the
real one away.

**O. Lightning preimage release race.** Every input to the Panel A preimage is
public, so a hold's preimage becomes derivable for anyone at reveal close
(§9.1). An entity that releases it can force a settle the slashing plan would
have cancelled. *Not mitigated cryptographically* — Panel A is social
slashing, and the control is that the release is attributable (the published
preimage matches the published witness) plus the host's cancel-before-release
ordering. Registered as PO-16; the script-enforced panel (B) does not have this
exposure.

**P. Bond-free escalation, and the free option.** Two defects in the escalation
path were found by attacking the fix that created it, not by reading it. (i) The
v0.12 witness bound the bond hash to the *case*: a juror holding no bond could
escalate by quoting a bonded juror's accepted hash, and — because the
append-only log is the artifact hosts use to attribute misconduct and price fees
— the log named the wrong challenger against the wrong bond (r29-1,
**EXPLOITABLE**, fixed in the reducer by requiring the challenge's index *and*
hash to be the challenger's own). Its residual is that the witness binds a bond
to an *index*, while `challengerPubkey` stays caller-supplied and unverified
against any registry (r29-5, which needs an idx→pubkey pin in the case state —
registered for the next API change). (ii) The same
witness admitted any bond the challenger had ever posted, so one payment bought
every rung and escalation was a free option worth 363 $b_0$ at the protocol cap
(r30-1, fixed in v0.13.0 by the per-round consumption test, §8.4). The bounded
residual is that amounts are host policy and a case may still be created with
the legacy membership semantics (`requireRoundBond: false`, the compatibility
default). *Both defects are structural-or-economic, both are now pinned by
tests, and neither was visible to the model checker before the witness event
existed — see §11.6 for why that matters.*

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
  re-verified at `resolve_round` and `finalize`; reveal ledgers
  re-verified before `close_reveals`/`finalize_tally`; signing records
  re-verified on every dispatch, with the signing-session hash re-derived
  (restored snapshots cannot edit outcome/threshold/roster post-hoc).
- **Monotonic clock ledgers** — every time-bearing event satisfies
  `now ≥ latestTimestamp` in all four machines (§6.4).
- **v2 policy downgrade refused** — v2-only finality policy on a v1-shaped
  event fails closed; an empty policy pin is invalid, never silently
  disabled (§7.3).

The per-invariant security argument — the formal invariant, its property,
and the literature anchor it rests on — is maintained as the
security-argument skeleton in the cryptographic-literature audit §7
(App. A, S-7); §11.5 describes how the audit program that produced it works as
the evaluation methodology, and §13 states how far each invariant is
established.

---

## 11. Reference implementation and verification

This repository *is* the reference implementation: platform-neutral
TypeScript (browser and Node), no UI, no networking of its own, no
persistence — hosts inject clocks, storage, signers, relay pools, and rail
adapters. The module map is in App. A.2.

### 11.1 Suite, simulation, and review record

- **Suite:** the full test suite is green and the typecheck is clean (source,
  scripts, and tests are all typechecked) — **1,686 passing, 1
  environment-gated live test skipped, over 76 files**, re-measured on this head
  (App. A.4; per-round record in App. A.1, S-12 §1). Coverage includes:
  BIP-350 official address vectors, FROST round-trips and
  partial-signature rejection, DKG complaint binding (forged/unattributable
  complaints rejected, genuine grievances disqualify, false complaints
  exonerate), poisoned-backup and negated-share rejection, strict NIP-59
  unwrap, escrow redistribution branches and integrity, LN ledger decisions,
  Liquid script/witness/skeleton correctness, adversarial parser fuzzing,
  the universal-confirmation pipeline and multi-round ladder, batch
  attestation trees/proofs/validators, v2 finality binding, the escalation
  witness and its per-round bond consumption, the derived ladder economics and
  penalty ageing, the NIP-59 seal-layer and MLS-transport games, inbox/outbox
  provenance bounds under a 10k-event flood, and the
  adversarial machine/relay/validator suites (§10.2). What the suite does and
  does not establish is §13's business, not this list's.
- **Whole-court simulation:** deterministic, hermetic execution of the
  *entire* pipeline — lottery selection, Pedersen DKG, commit–reveal vote with
  one incoherent juror, FROST signing, production-path attestation validation
  (kind 39007 with full context), escrow slashing plan with integrity check, LN
  hold settle/cancel via the `LnRail` contract, Liquid escrow address + release
  skeleton + broadcast via the `LiquidRail` fake. Same seed ⇒ same group key,
  same Liquid address, same decisions. The wall-clock gate is a
  **deterministic budget** (`SIM_BUDGET_MS`, default 30 s) preceded by
  behavioural assertions, and the helper itself is pinned — a mutant returning
  an infinite ceiling had survived all 23 budgeted tests, which is how the gap
  was found (r29-10, §11.6). This is the executable backing for every
  claim above: each section maps to running, tested behaviour.
- **Review record:** the repository's findings documents, the normative
  invariant reference, the complaint-protocol note, the three review-round
  audits (`docs/REVIEW_ROUND_2.md`, `docs/REVIEW_ROUND_3.md`), the per-round
  bond note, the multi-process ceremony note, and the cryptographic-literature
  audit — consolidated, with their file locations, in App. A.1 and A.5.

### 11.2 Exhaustive model checking

Beyond pinning tests, the three ceremony phase machines — vote,
confirmation, and signing — are verified by **exhaustive finite-state-space
exploration**: every reachable state × every event application, asserting
at every step:

- **P1 phase legality** — the phase is always in the machine's declared set;
- **P2 data invariants** — ledger ⊆ roster with unique indices, reveals ⊆
  commits, ballot closure, real SHA-256 commit–reveal / confirmation-hash /
  signing-session-hash re-derivation, real secp256k1 nonce points,
  signer-set freeze == distinct commitment set, partials ⊆ finalized
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
  instance;
- **P6 illegal-witness immunity** — since v0.12 the confirmation machines have a
  witness-gated `escalate`, so the explorer dispatches an **illegal escalation
  witness matrix at every reachable state** (wrong authority, foreign
  challenger, non-roster challenger, malformed hash, bond the case never
  accepted, another challenger's bond, wrong round, replay of a consumed
  per-round bond, host authority without the frozen policy, oversized values).
  Any acceptance fails the instance outright;
- **P7 witness-log bound** — `escalationLog` never exceeds
  `min(maxLadderRounds, MAX_LADDER_ROUNDS)` at any state, and every terminal
  phase refuses a *perfect* witness (the terminal-absorption case).

The committed sweep fixture — regenerable from one command (App. A.4) —
covers **15 instances**:

| Metric | Value |
|---|---|
| Concrete states explored | **3,869,232** |
| Event applications | **213,521,172** |
| Illegal-event checks (typed rejection exercised) | 145,907,861 |
| Typed throws | 195,033,132 |
| **Illegal escalation witnesses dispatched** | **60,020,684** |
| **Illegal witnesses accepted** | **0** |
| Max observed `escalationLog` depth | 2 |
| **Raw throws (`TypeError`/`RangeError`)** | **0** |
| Progress edges / idempotent self-loops | 12,796,460 / 5,691,580 |
| Determinism paths replayed | 3,000 (all byte-identical) |

The two instances the witness surface added are
`confirm n=3 q=1 r=2 escalate-witness challengers=1,2` (537,825 states,
18,271,978 witness probes) and `confirm n=3 q=1 r=3 host-escalation` (182,265
states, 6,188,788 probes); all six confirmation instances together account for
60,020,684 probes, and probing — not exploration — is now the sweep's dominant
cost (2,525 s full-mode versus 1,196 s for the pre-witness sweep).

Abstraction limits are stated honestly: explored rosters are small
(n ≤ 3–4, reduced clocks), because the state space grows combinatorially —
but the explored transitions are the machines' *own* reducer code paths, so
the properties are checked on the production guards, not on a model of
them. Two findings about the *checker* belong here rather than in a changelog,
because they are what a bounded explorer can and cannot claim:
**MC-F7** — a variant instance whose state space equals its base's is not
exercising what it claims (the partial-equivocation instance was repaired from a
vacuous 19,822 to 116,906 states), and **MC-F8** — the same class one level down:
the witness fixtures were all-digit hex, so the "uppercase hex" probe was a
no-op until the illegal-witness assertion caught it. Both are recorded in App.
A.3, and both say the same thing: *a sweep is only as good as the fixtures it
dispatches.* The complementary lesson is §11.6's: an independent property that
mirrors the implementation cannot catch the mirror — this explorer's own
escalation-bond property had codified the same weak predicate that r29-1
exploited, and it agreed with the bug until the attack rewrote the property.
**Scope note:** the DKG machine (`courtDkgMachine.ts`, INV-DKG-1…12) is
*not* in the exhaustive sweep, by design: its peer events carry cryptographic
payloads (encrypted shares, PoKs) whose validity is decided outside the
reducer, so state-space exploration would mostly exercise typed rejection of
material the machine cannot inspect internally; its structural invariants
(unanimity, single-transcript certification, clock ledger, terminal
absorption) are pinned by the invariant/adversarial suites instead, and
extending the explorer to the DKG's structural event space is a registered
follow-up (RS-1 in the review register). Methodology and abstraction limits are
recorded with the sweep itself (App. A.4).

### 11.3 Differential parity — the spec-pinning methodology

Every critical pure function of the Court is reimplemented a second time —
different algorithm, different library, same contract — and asserted to agree
with the production implementation across exhaustive inputs. This is an
**in-house differential**, not an independent reimplementation: the same
authors wrote both sides, so a shared misreading of the specification would
survive it. What it does establish is regression pressure — a disagreement is
*always* a finding, either an implementation bug or an under-specified
contract, and drift in either side fails the suite. The five areas:

1. **CanonicalWriter** — a reference byte-accumulator writer plus an
   independent *parser*: byte-identity, round-trip, prefix-freeness,
   injectivity, boundary + unicode cases, fail-closed ranges.
2. **Batch Merkle tree** — a reference array-slice RFC-6962 builder and a
   record-and-replay proof verifier: exhaustive for n = 1..128, every proof
   verifies, tampered paths reject; the O(n) full-set generator is pinned to
   the same reference verifier for n = 1..128, 333, 1000.
3. **Verdict / manifest / attestation-v2 hashes** — `node:crypto` SHA-256
   vs `@noble/hashes`: randomized + boundary agreement.
4. **Selection lottery** — an exact differential on the u32 draw and the
   end-to-end ranking, and a *statistical* differential (chi-square,
   moments, winner law over 100k draws) between the production exponential
   clock — $-\ln(r)/\sqrt{w}$ on the stake path, $-\ln(r)/w$ in weight mode,
   §4.2 — and a second inverse-CDF clock. Exact-equal and statistically-equal
   assertions are documented separately.
5. **Plurality + tie-break** — a reduce-based reference tally vs the
   machine's map loop: exhaustive $3^n$ assignments (n ≤ 4), random big
   tallies, and the UTF-8 (not UTF-16) tie-break divergence pin.

All randomness is seeded, so every assertion is reproducible. The methodology's
name is deliberate: the second implementation is a readable restatement of the
*specification*, so this suite pins the spec — not the code — and a future
rewrite that changes observable behaviour fails here first. What it cannot pin
is a specification both sides misread; only the third-party FROST
cross-implementation differential of §12.5 (still open) can do that. The same
limitation applies with more force to the model checker (§11.2): a property that
restates the guard it checks inherits that guard's misreading — r29-1 is the
case where it did, and §11.6 is the method that caught it.

### 11.4 Performance baseline

Every number below is regenerable by one command (App. A.4). Measurements:
`process.hrtime.bigint` (no wall clock anywhere in a measured path), 3 warmup
passes, 9 timed samples, median/p95/**min** reported — `min` is the noise-floor
estimator. **Environment:** a shared 16-thread AMD Ryzen 7 PRO 8840HS box,
Node v22.23.2 on linux x64, moderate concurrent load; no network, no
persistent storage, fixed-seed fixtures.

**Reproducibility, including what failed.** Two independent full runs on the
same commit and host agree within ±20% on 27 of 29 timed benchmarks (median
deviation 5.8%). The two outliers are both µs-scale micro-benchmarks —
`buildBatchMerkleTree` (10 leaves) at 30% and `buildAttestationMessageV2`
(6 extensions) at 26% — i.e. rows whose total runtime is small enough that
scheduler noise dominates. A third run, taken while the box was saturated
(load ≥ 20), reproduced *none* of the figures (deviations up to ×18) and is
excluded as an environment artifact, not treated as a code change. These are
baseline numbers for one class of machine, not a performance guarantee; CI
budgets must be set against `min` on a quiet box.

| Benchmark | Params | median | note |
|---|---|---|---|
| `verifyCaseInBatch` | 10 … 10,000 leaves | ~1.3 ms **flat** | O(log n) tree + one Schnorr verify |
| `buildBatchMerkleTree` | 10,000 leaves (cap) | 132.6 ms | linear; max batch cost bounded |
| `buildBatchMerkleProofs` (full set) | 10,000 leaves | ~71 ms total | ~450× vs naïve per-leaf (~O(n²)) |
| `validateAttestationEvent` (v1) | kind-39007, supporting=6 | 1.39 ms | Schnorr-verify floor ~1.3 ms |
| `validateAttestationEventV2` | kind-89, ext=6, supporting=6 | 1.31 ms | same floor |
| `reduceCourtSigningMachine` | 10k transitions, roster=threshold=21 | 110 µs | 30× vs the pre-optimisation implementation (point-validity memo) |
| `reduceCourtVoteMachine` | 10k transitions, roster=21 | 17.8 µs | |
| `reduceCourtConfirmationMachine` | 10k transitions, roster=3 | 9.5 µs | |
| `selectJury` | roster=10,000 | 32.5 ms | 2.7× vs the pre-optimisation implementation |
| `canonicalWriter.encodeHash` | 1,000 field groups | 1.48 ms | 4.4× vs the pre-optimisation implementation |

**End-to-end, not just per-call.** Composing the rows: verifying one case out
of a 10,000-verdict epoch costs ~1.4 ms (a ~14-hash Merkle fold plus one
signature verification), i.e. roughly 700 case verifications per second on one
core, and it is the *same* cost as verifying one case out of ten — so
verification of a settlement does not degrade as the epoch grows. Constructing
that epoch's batch costs ~133 ms for the tree plus ~71 ms for the full proof
set (~204 ms total, ~23 MB of retained heap), and drawing a jury from a
10,000-candidate roster costs 32.5 ms. The signing and confirmation reducers
are far below the signature floor (110 µs and 9.5 µs per transition), so the
end-to-end cost of an epoch is dominated by Schnorr verification, not by the
protocol machinery.

The measured facts the design relies on: **verification scales flat,
batching scales linear** — per-case batch verification is $O(\log n)$ in
the tree plus one signature check, so a 10k-verdict epoch batch costs the
same to verify per case as a 10-verdict one, and the 10k tree build is
bounded and modest. Optimizations never change byte output: the performance
work behind these rows was pinned byte-identical by the differential-parity
suite before landing.

### 11.5 The review record: who reviewed what, and what it is not

The paper's claims were checked more than once, and by more than one kind of
reviewer. This subsection names them and states each one's limits, because
"reviewed" without those qualifiers is precisely the kind of word this paper
should not use.

**1. In-house audit and symposium program.** Rounds of work conducted *inside
this repository*: adversarial rounds (validator and finality scope,
cross-module state-shape and canonicalization attacks, and the property sweep
that found a mid-ladder dead end); a formal invariant pass that produced the
normative invariant reference from the actual guards; the exhaustive model
checking of §11.2; a cryptographic literature audit that anchors every
mechanism to its source (FROST and Drijvers-style two-round attacks, RFC 9591,
Crites et al. at CRYPTO 2025 for adaptive security, ChillDKG/BIP-445, the
ZF-FROST refresh vulnerability record [20], RFC 6962); a differential-parity
round; a performance round that also records the optimizations it *refused*;
a host-side mechanism audit; a quantitative gap-fills round (capture
probability, per-rail cost of corruption, the P+ε argument, the seed-grinding
bound, and √k stake splitting — App. A, S-15); and a proofs round producing
six line-checked theorems (App. A.2 — T1–T5 on the core protocol, T6 on
attribution under its two named premises). The reviewers were AI agents working in
the repository,
directed by the project. They are not disinterested — they wrote the code they
audited — and that is why §13 labels the evidence by kind rather than treating
it as a single verdict.

**2. Three-round multi-agent editorial audit (2026-11-10).** This document was
then reviewed by a three-round multi-agent program — parallel review agents,
each assigned a section — whose verdicts are applied here: assurance framing
and rank language; related work; provenance hygiene; statement corrections;
disclosure; scope. The output is editorial — wording, structure, and the
statement corrections listed in App. A.3. It found no new cryptographic result
and established none.

**3. Three external AI reviews (GPT, Claude, Gemini; 2026-11-10).** Independent
models reviewed *this paper text*. Their scope limits are exact and should be
read as the boundary of what their verdicts mean: **paper-only, no access to
the repository code, no execution of the suite or the benchmarks, no
cryptographic analysis of the implementation, no formal verification.** They
caught overclaims, unstated assumptions, missing related work, and imprecise
statements — which is what a careful reader of a text can do — and they are
not a security audit of the system the text describes.

**4. Fix-and-re-attack rounds (rounds 29–31, 2026-11-11).** The program then
turned on itself: each round took the *fixes* the previous round shipped and
attacked them as an adversary holding the reducer, the HTTP route, or the env
var. This tier found: a **bond-free escalation** (r29-1, `EXPLOITABLE` — a juror
with no bond quoting a bonded juror's hash, with the audit log naming the wrong
challenger), a **durable inbox that a 65-relay delivery could brick** (T-1), a
**ladder bond that priced membership instead of consumption** (r30-1 — escalation
as a free option worth 363 $b_0$), a **vacuous test ceiling** that had survived
all 23 budgeted tests (r29-10), and — against its own instrumentation — a soak
that had been **red on `main` for two protocol rounds** without anyone noticing
(SOAK-F8). §11.6 states the method, what it is worth, and what it is not; it is
the strongest contributory evidence in this paper in the specific sense that it
is the only tier whose findings were *unknown to the authors until the tier
looked*.

**What none of this is.** No independent human cryptographer has reviewed this
design. No third-party security audit, side-channel analysis, or supply-chain
audit has been performed. Nothing here has been peer-reviewed, and this
document has not been submitted anywhere. Those absences are why §12 gates
deployment engineering and why §13 marks each claim with the *kind* of evidence
behind it instead of asserting that the system "has been verified".

The methodology a reviewer should apply is therefore: not "the authors
assert", but "this claim is anchored to a proof, a machine-checked bound, a
measurement, or a named open obligation — and here is the artifact that says
which".

### 11.6 The review verifies itself

The fourth tier above is not a review of the paper. It is a review of the
**fixes**, and it is the part of the program that produced this paper's most
uncomfortable results — so its method and its limits are stated here rather than
implied.

**Method.** Round $n+1$ takes the artifacts round $n$ shipped as its attack
surface. The attacker is not a reader but a caller: it holds the reducer, the
HTTP route, or the environment variable, and it is bound by one grading rule —
a finding is **`EXPLOITABLE` only when a test in the repository (or a cited host
code path) demonstrates the harm**; otherwise it is **`PARTIAL`** (the guard
exists but is incomplete) or **`BLOCKED`**, with the guard cited by file and
line. Two instruments make the grade auditable rather than rhetorical: the new
tests must *fail before* the fix and pass after (round 29: 15 targeted tests, 4
of them red on the pre-fix head), and **mutation probes** ask whether the
existing suite notices when a guard is removed (a mutant returning an infinite
simulation ceiling survived all 23 budgeted tests — the ceiling was decorative).

**Why it is stronger than it sounds.** It is the only tier whose findings were
*unknown to the authors until the tier looked*, and it caught three classes that
a reading review does not reach: a **binding asserted in prose but not in the
reducer** (r29-1: the bond was bound to the case, not to the challenger, so a
non-bonded juror could escalate and the audit log named the wrong person); an
**operational brick reachable without a key** (T-1: an inbox that a 65-relay
delivery made unrestorable, i.e. every message lost on the next restart); and an
**economic hole inside a structural guard** (r30-1: the witness proved *a bond
exists*, not that *this rung was paid for*, so one bond bought the whole ladder).
The two findings are also the reason this paper does not treat its own model
checker as an independent witness: the explorer's escalation-bond property
**mirrored the weak predicate** and agreed with the bug (r29-1). A mirror cannot
catch a mirror; the attack — re-deriving the binding from the threat model,
per-actor — is a genuinely different method, and that is the taxonomy claim
being made here.

| Self-found defect | How it survived | Fix and pin |
|---|---|---|
| **r29-1** — bond bound to the case, not the challenger (`EXPLOITABLE`) | the witness proved *some* accepted bond existed; the factory helper checked the challenger, but the hostile-host threat model speaks the reducer directly; the model-check property restated the same weak check | reducer requires `challenge.idx === challengerIdx` ∧ hash match; INV-ESC-5 restated, model-check property corrected, 2 failing tests now green; residual r29-5 (idx→pubkey pin) |
| **T-1** — 65-relay provenance overflow bricks the durable inbox | `ingest` appended one URL per relay without a cap; `fromSnapshot` rejects > 64 relays as `corrupt_snapshot`, so *one* wrap delivered by 65+ relays made the whole inbox unrestorable — no key required | cap provenance at the first 64 distinct sources (delivery order), keep advancing `lastSeen`, keep restore strict; regression in the load suite |
| **r30-1** — the ladder bond was a membership test | the witness admitted any bond the challenger had ever posted, so $\Delta C_{r+1} = 0$; the structural invariant held while the price was zero | v0.13.0 per-round consumption (INV-ESC-9) + `assertValidEscalationLog` re-derivation at `finalize`; compatibility matrix and 12 tests |
| **r29-10** — a vacuous test ceiling | the budget helper was unpinned, so a mutant returning `Infinity` passed every budgeted assertion | the helper's default, junk fallback, override and ordering are asserted (3 tests) |
| **SOAK-F8** — the soak was red on `main` | nothing re-ran the soak on protocol changes; vendored v0.12.0 required an authority witness while the reference handler played an unwitnessed `escalate` | soak drives the real §9.2 path; unmodified `main` re-measured at 11/17 assertions, 289 stuck cases, 48,089 retries |

**What it is not.** It is still self-review: the same authors choose the targets,
hold both the attack and the defence, and work from the same threat model — so a
specification-level misreading shared by both sides survives it exactly as it
survives the differential parity of §11.3. It has no incentive asymmetry (an
outside reviewer is rewarded for finding something; the author is rewarded for
the release being green). And a fix that nobody attacks is not evidence of
anything. That is why this tier is *added to* the taxonomy of §13, not
substituted for the independent audit that section still lists as absent.

**The full record.** Every round this method has produced — the improvement
rounds 1–4, symposium rounds 5–21, the 2026-11-10 external reviews
(GPT/Claude/Gemini), review rounds 2–6, and the instrument rounds 29–37 that
supply the measurements quoted here — is mapped in
[`REVIEWS_INDEX.md`](REVIEWS_INDEX.md): per round, the attack surface, the
findings by severity, where the fix landed (PR and release), and how each
residual was dispositioned; plus the **eight-class failure taxonomy** the
campaign has actually found (trust-boundary pinning, state-restore divergence and
its over-strictness mirror, bond/economics binding, report-vs-decision mismatch,
vacuity, flood/eviction, attribution) and every headline number with the artifact
that produced it. The `REVIEW_ROUND_*.md` documents remain the authoritative
statements; the index is the map, and it names the source for each number.

### 11.7 Evidence at scale, across processes, and over time

Three artifacts extend the evidence beyond single-process, single-instance
checks. Each is stated with the scope it actually has, because all three are
easy to over-read.

**Statistical corpora.** Nine seeded campaigns — confirmation sequences, tallies,
Merkle batches, signed attestation events, jury draws, encodings, escalation
witnesses, epoch rotations and whole finality chains — run **1,187,000 units and
3,745,566 assertions with zero failures in 10.1 minutes** of corpus time on the
reference host; the three round-29 campaigns are the v0.12 surface (10,000
witness events over a 27-row matrix through the real reducer: 740 accepted,
9,260 typed refusals, 0 raw errors; 1,000 kind-39018 batches across 39 cohort
rotations; 5,000 verdict chains with witnessed escalations and terminal-witness
refusals). CI runs a bounded fast subset of every campaign, so the corpus is
enforced continuously rather than quoted. **Scope:** these are *statistical*
sweeps over generated inputs — the exhaustive counterpart is §11.2, and neither
subsumes the other (App. A, S-20).

**A three-day fault-injected soak of the host pipeline.** 30,000 settlements
(10,000/day over 3 virtual days plus a 38 h drain = 110 virtual hours) in 5.7
minutes of wall clock, **32/32 assertions green**: the 19 pre-existing
invariants now measured *across* epoch boundaries, plus 13 for rotation,
retention, faults and the bonded-witness path. Zero lost deadlines, zero
double-publishes, zero re-applications, sat-exact ledger parity per day and
cumulatively (150,180,128 sats), zero unattributed spurious redeliveries, zero
unaccounted acks, one machine feed per accepted escalation request. The faults
are seeded and deterministic: relay partitions that hold writes and deliver them
late or out of order, 10 % mid-day juror churn, coordinator restarts with all
volatile state dropped, 100 witness-storm events per day (replays, wrong round,
forged bond, case mismatch), and a PITR-style ack-cursor rollback of −2 h. The
§9.2 witness path ran at volume through the real escalation service (1,627
requests, 1,393 machine feeds, 0 duplicate feeds, ≤ 2 escalations per case).
**It found three real defects, one of them about itself:** SOAK-F8 — the older
soak had been **red on `main` for two protocol rounds** (the reference handler
emitted an unwitnessed `escalate`, which vendored v0.12.0 refuses), measured on
unmodified `main` at 11/17 assertions, 289 stuck cases, 48,089 handler retries;
SOAK-F7 — the reconcile replay overlap is a re-*serve* window, not a
delivery-delay bound, so a partition longer than the overlap walked the cursor
past unserved acks (8 of 184,620 silently lost), fixed by lagging the watermark
one overlap behind `now`; and SOAK-F11 — a ladder rung that re-draws an
already-served juror inserts nothing against the `(case, juror, kind)` unique
key, so that juror's ack bound to no row and no error was raised. **Scope:** the
soak runs unmodified services against an in-memory Postgres and a virtual clock,
so it validates logic, ordering and event volume — not real-Postgres
serialization, fsync latency or relay RTTs. It is a host-repository artifact
(App. A, S-22).

**Transport: one operational brick, and the ceremony across real processes.**
The round-30 transport campaign attacked the durable inbox and the NIP-59 seal
layer, and found T-1 (§11.6): a single wrap delivered by 65 or more relays
produced a snapshot the restore path must reject, so **the entire inbox —
every message, not just that one — was unrestorable on the next restart**, and a
hostile relay set could trigger it for a legitimate recipient without any key.
The fix caps a record's provenance at the first 64 distinct sources (delivery
order, so it is deterministic), keeps advancing `lastSeen`, and leaves the
restore check strict so a tampered store is still rejected; the seal-layer
suites pin the attacks each layer catches, including the honest boundary that a
*consistent* forgery is stopped by the roster gate rather than the wrap. The
same round ran the ceremony as **N = 3…7 real OS processes** — separate PIDs,
heaps, identities, state directories and poll cursors, exchanging signed Nostr
events through a loopback relay that assigns the total message order, with the
production parsers and the real Pedersen DKG and FROST rounds, and a coordinator
that re-derives the group key from the published commitments and verifies the
aggregate itself. `SIGKILL` mid-DKG makes every survivor fail closed with
`DKG_MISSING_PARTICIPANT` and accept **no** group key (the attempt is never
shrunk to a threshold subset); `SIGKILL` mid-signing still completes the DKG and
then fails closed with `SIGN_MISSING_REVEAL` and no signature; a cross-round wire
replay is detected as equivocation, the replayer is disqualified, and no
signature is produced. **Scope, stated because it is the standing objection
this harness answers:** it is still *localhost* — one kernel, one clock, no
packet loss, partitions, clock skew or congestion; the relay is honest and
always available; custody (HSMs, disk encryption, backup/restore) is not
simulated; and Byzantine liveness is unchanged (one dead juror stalls the
attempt). The *coordination* structure is real; the *distribution* gap remains
PO-14 (App. A, S-19).

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
   consumers must run it distributed). The *coordination* half is now exercised
   across N = 3…7 real OS processes with independent identities, crash and
   replay fault injection, third-party message ordering and independent
   verification (§11.7, App. A, S-19) — on one host. Network asynchrony, real
   relay failure modes, key custody and machine-independent timing remain
   PO-14, and the harness note says so in the same words.
3. Contract-enforced phase deadlines on-chain (currently coordinator-level).
4. ChillDKG suite upgrade (planned; `pedpop-v1-experimental` is the active
   suite and must never be *labelled* ChillDKG; ChillDKG shares must never
   feed `@vbyte/frost` signing until BIP-445 vectors and cross-implementation
   parity pass).
5. Independent side-channel audit, supply-chain pinning, and a public
   testnet bounty. Differential parity against a *third-party* FROST
   implementation remains open — the differential-parity suite (§11.3) covers
   the Court's own pure functions against in-house restatements, so a
   cross-implementation FROST differential is the remaining half of this gate.
   The upgrade triggers that gate the pinned `@vbyte/frost` version are in the
   literature audit §6 (App. A, S-7).
6. **Settlement binding (A6).** v1 is host-mediated: the cohort authorises,
   the host releases. Two pieces are specified and not shipped — the
   spend-session binding (the signing-session hash extended with
   `marketId ‖ attestationDigest ‖ planHash ‖ sighash`, and a signer that
   refuses a spend partial without a valid attestation) and, for Liquid
   binary/escrow rails, the `CHECKSIGFROMSTACK` judge leaf. Both, plus the
   market-creation coverage rule that a market must not outlive its cohort,
   are in the settlement-binding note §2 and §4. Until they land, the
   correct description of the rail is "threshold attestation + host-mediated
   release", never "no single party can release".
7. **Lightning forfeiture (PO-16).** Panel A's preimage is derivable by anyone
   (§9.1), so refusing to pay an incoherent juror is a host policy plus an
   attributable race, not a cryptographic forfeiture. Either a settlement
   construction with a secret witness or migration of the economic layer to
   the script-enforced panel closes it.
8. **The economic layer is host policy, and part of it lives outside this
   package.** The package enforces the *shape* — the per-round bond must be
   distinct, consumed once, present when the case demands it (INV-ESC-9) — but
   not the *amounts*, the cap, or the bond registry: `deriveCourtEconomicCap()`
   is a host function (r29-9), the per-round price `ΔC_R = 3^R b_0` is host
   policy, and one on-chain bond accepted as the challenge bond of two cases is
   a host-registry dedupe duty with a chain verifier, not a reducer predicate
   (r29-4; the escalation route currently checks the hex shape only). The
   residuals are registered with their closure paths in the round documents
   (App. A, S-17, S-18, S-21); the two that were reachable in the host
   deployment — the cap measured on a client-declared number (r29-7) and the
   ladder read live from the environment after the cap froze (r29-8) — are
   closed there (server-side exposure basis, per-market ladder freeze, effective
   cohort size, `min(cap)`), which is precisely why they are listed here as a
   gate rather than as shipped evidence.

---

## 13. Scope of verification

A single sentence such as "the court is secure" would hide five different
claims with five different kinds of evidence. Table 2 separates them. The
column "Status" uses four labels and nothing else: **proven** (a written
argument with its premises stated — line-checked for T1–T6 in App. A.2, and a
reduction to a cited theorem elsewhere); **machine-checked** (exhaustive or
bounded exploration of the implementation itself, within declared abstraction
limits); **empirically evaluated** (measured or differentially tested, with the
method named); and **open obligation** (a named gap, PO-* in the obligation
register, with its closure path). A claim that carries more than one label is
listed with the weakest link named.

The four labels say *what kind* of evidence stands behind a claim. They do not
say how the evidence stays honest as the code moves under it, and that is a
distinct question with a distinct answer, so the taxonomy has a fifth axis: the
**review that verifies itself** (§11.6). A status is a snapshot; the property
this paper actually relies on is that each round re-attacks the previous round's
fixes with the reducer, the route or the env in hand, requires a failing-before
test to call something `EXPLOITABLE`, and re-runs the whole battery on the new
head. Three of this paper's own defects were found that way and not by a
reviewer: a bond-free escalation (r29-1), an inbox a 65-relay delivery could
brick (T-1), and a ladder bond that priced membership rather than consumption
(r30-1) — plus a soak that was red on `main` without anyone noticing (SOAK-F8).
The axis is listed here because it *earns* the labels above over time; it is
also the weakest defence in the table by authorship, since the attacker and the
author are the same people — which is exactly why the independent audit remains
the one absent tier (§11.5) and nothing below is labelled *independently
verified*.

**Table 2. What is guaranteed, under which assumptions, by what evidence.**

| Claim class | The claim, precisely | Assumptions | Evidence | Status |
|---|---|---|---|---|
| **Cryptographic security** — attestation unforgeability | No attestation validates under the pinned group key unless $\ge M$ distinct certified shares signed that exact message triple (session, outcome, round, signer set). | Schnorr EUF-CMA; FROST binding-factor soundness (KG20/RFC 9591, adaptive form under LDVR [19]); honest-key generation; the pinned library implements those semantics (probe- and differential-pinned, not verified from source — GAP-5a). | Theorem T5 (App. A.2), proved; the verification direction is conditional on the crypto premises; the pipeline direction (valid attestation ⇒ distinct partials) is unconditional. Who signed a given attestation is Theorem T6: the bare aggregate names no one, and the session journal is what attributes it (conditional on the certified-share pin P1 and authenticated entries P2). | **Proven** (conditional) + **open obligation** PO-13 (assumption watch), GAP-5a (dependency fidelity) and PO-18 (attribution is detective; the journal is host-side in v0.11) |
| **Cryptographic security** — secrecy of the group key | Fewer than $M$ corrupted jurors learn nothing about $f(0)$, and the public ceremony transcript yields at most $m$ interpolation points to a coalition of size $m$ under possession-bound complaints. | Shamir perfect privacy [2]; honest majority $m+1 \le t$ for the complaint bound; the DKG never has a dealer. | Shamir privacy (§2.3) and the transcript-counting argument (§2.4), both with premises stated; the complaint-binding suite pins the mechanism the argument relies on. The transcript bound is *not* a line-checked theorem. | **Proven** (reduction to Shamir privacy + counting argument) + **empirically evaluated** (forged- and unattributable-complaint rejection) |
| **Protocol safety** — state machines | Every reachable state of the vote, confirmation, signing and DKG machines satisfies the INV-* bundle; no illegal transition is accepted; no illegal escalation witness opens a round; no raw `TypeError`/`RangeError` escapes. | ECMAScript semantics (premise J1), canonical UTF-8/hex inputs, monotone host clock. | Theorem T4 (structural induction over event sequences, all roster sizes) plus exhaustive model checking of three machines (15 instances, 3.87M states, 60,020,684 illegal-witness probes with 0 accepted, 0 raw throws) within n ≤ 3–4 and reduced clocks; 158 stated invariants, each with an enforcement pointer. | **Proven** (T4) + **machine-checked** (three machines; DKG machine is invariant-pinned only, RS-1) |
| **Protocol safety** — tally and encoding | The verdict is a function of the reveal multiset; the tie-break is a strict total order; canonical encodings are injective and prefix-free per schema. | J1; SHA-256 collision resistance for the hash bindings. | Theorems T1 and T3 (proved); exhaustive differential over small domains; the UTF-8-vs-UTF-16 divergence pinned. | **Proven** + **empirically evaluated** (in-house differential, §11.3) |
| **Protocol safety** — batch inclusion | Accepting an inclusion proof implies the recomputed leaf is in the committed set; domain separation blocks leaf/node confusion. | SHA-256 collision resistance; Schnorr EUF-CMA for the manifest signature. | Theorem T2 (proved; soundness conditional, completeness unconditional); exhaustive proof verification for n ≤ 128 plus the cap. | **Proven** (conditional) |
| **Protocol safety** — finality | A stale artifact cannot satisfy current policy: v2 binds epoch, tier, threshold, signer-set root and batch root in-band, and v1-shaped events fail v2-only policy. | Consumers pin the expected group key — *caller pins, not the event* (an unpinned consumer accepts any group's signature). | §7.3 design + adversarial validator reproduction suite; T5 covers the signature, not the pinning duty. | **Machine-checked** (within the suite) + **open obligation**: the pinning duty is a trust assumption, not a mechanism (PO-10 for the unbounded v1 path) |
| **Protocol safety** — selection | The draw is publicly recomputable from the published seed and block hash, samples without replacement with probability ∝ $\sqrt{w}$ on the stake path, and fails closed on invalid weights. | Uniform 32-bit draws from SHA-256; the seed is unbiased at the required depth (A5). | Exponential-race proposition (§4.2, proof sketch); statistical differential (chi-square, moments, winner law over 100k draws); property tests for fail-closed behaviour. | **Empirically evaluated** + **open obligations** PO-2 (seed anchoring / grinding) and PO-17 (cross-engine ordering) |
| **Operational resilience** | Up to $N-M$ jurors may be absent without preventing a signature; an unresponsive or censoring oracle cannot block the refund path; no wedged state exists in the three model-checked machines. | A2 (≥ M honest jurors participate); relay delivery liveness L1; absolute deadlines enforced (contract-level enforcement still open). | Model-checked no-dead-ends and termination (P3/P4) for three machines; refund path by construction; the end-to-end simulation; a three-day fault-injected soak at 30,000 settlements (32/32 assertions, faults: partitions, churn, restarts, witness storms, cursor rollback) on the host side; the ceremony across N = 3…7 real OS processes with crash/replay injection (§11.7). | **Machine-checked** (bounded) + **empirically evaluated** (soak, ceremony — single host, virtual clock) + **open obligations** PO-3 (partition/eclipse liveness — no availability proof) and the on-chain deadline gate (§12.3) |
| **Operational resilience** — prototype gap | A single-process ceremony reveals all shares to whoever compromises the process. | — | Stated as a production gate (§12.2); the *coordination* half (separate processes, identities, ordering, independent verification) is exercised on one host (§11.7). | **Open obligation** PO-14 (cross-client deployment) |
| **Economic robustness** | Coherent jurors strictly prefer revealing; non-reveal and double-voting are dominated by honest play *given* coherent-majority focal behaviour, slashing exceeds any capturable bribe, escalation is priced per rung (a consumption test, not a membership test), and selection is unpredictable. | The Schelling-point focal strategy (Kleros model [9, 18]); a bribe market that prices below the slash; unpredictable selection (§4); per-round bond amounts posted by the host at `ΔC_R = 3^R b_0`. | Integer-exact redistribution with a conservation check; the 50/100% split; clawback idempotence; the per-round consumption invariant (INV-ESC-9) and its restored-snapshot re-derivation; the measured ladder arithmetic (free-option cost 363 $b_0$, deterrence −2.40 %→−1.86 % of $V$, venue/griefer 0.86×→54.1×, derived cap and flip round, churn 2.47× short, κ slack) — App. A, S-21. | **Empirically evaluated** (arithmetic, invariants, and a re-verified incentive model) + **open obligation** PO-1: the bribe equilibrium for a $\lceil 2N/3\rceil$-of-$N$ jury is *not* modelled; the composite-SLA residual (attendance vs coherence) is named in §7.4; the ladder *amounts* and the bond registry stay host duties (§12.8) |
| **Economic robustness** — Lightning panel | Panel A orders settlement after the verdict, but does not enforce forfeiture. | Honest host behaviour + attributable release. | §9.1 analysis. | **Open obligation** PO-16 |
| **Real-world validity** | The design's assumptions hold on live infrastructure: honest juror mass, encrypted channels between independent devices, relay liveness, Bitcoin seed freshness, and a release path that enforces the attestation. | A2, A3, A5, A6. | The protocol package is unit- and simulation-tested; the ceremony runs across real OS processes but on **one host** with an honest relay; the host pipeline has been soaked at 30,000 settlements with injected faults; *no* live multi-operator ceremony has been run at the scale the design targets, and the release path is host-mediated in v1. | **Open obligations** PO-14, PO-15, plus the §12 engineering gates (rail execution, cross-client, third-party audit) |

Two readings of Table 2 matter. First, the rows marked **proven** are proofs
*of the specified protocol* under stated premises — not proofs that the
implementation refines the specification; that link is the differential and
model-checking evidence, which is in-house. Second, every row carries at least
one open obligation, and those obligations are the paper's honest perimeter:
they are the difference between "designed and checked" and "deployed and
independently audited".

A third reading follows from §11.6 and matters for the rows that moved in
rounds 29–31: three of the entries above are weaker than they were two rounds
ago *and say so*. The escalation authority row gained a consumption invariant
because the previous row was a membership test (r30-1); the operational row
gained a soak and a ceremony because neither existed; and the economic row went
from "arithmetic and invariants" to a re-derived incentive model with two
premises corrected — one of which (r30-3) says the paper's own prompt was wrong
in our favour, which is the kind of correction a self-review is *least* likely
to make and therefore the one worth publishing. None of that upgrades a status
label. A fix that survived an attack is still a fix that only its authors have
attacked.

---

## 14. Conclusion

BAO Court replaces the single-key dispute fallback with a just-in-time FROST
threshold oracle — and, in its current form, with a *universal* one:
juries form only when needed (or once per epoch for standing cohorts), no
party ever holds the group secret, every verdict rests on panel evidence
rather than the platform's word — though v1 release is host-mediated and can
proceed without one (PO-15) — and a verdict is a single ordinary Schnorr
signature — or one signature covering an entire epoch's verdict cohort via
a Merkle batch — that any observer can verify with an $O(\log n)$ inclusion
proof. The economic layer (ownership proofs, escrow ledger, Kleros-style
slashing, flip-flop clawbacks) and the dual-rail settlement specification
(Lightning hold invoices, Liquid script escrow) are deterministic and
publicly recomputable; custody, execution, retention, and SLA policy stay
with hosts. The design is backed by an evaluation methodology rather than an
assertion: six line-checked theorems, 158 stated invariants, exhaustive
reachability model checking of three of the four ceremony machines on bounded
instances (the DKG machine is invariant-pinned only) with 60,020,684 illegal
escalation witnesses dispatched and none accepted, in-house
differential parity, a regenerable performance baseline, statistical corpora of
1,187,000 cases and 3,745,566 assertions, a three-day fault-injected soak at
30,000 settlements, a ceremony across real OS processes on one host, and a
literature-anchored audit record (§11), with §13 stating which claim rests on
which kind of evidence — and §11.6 stating why the program's habit of attacking
its own last release is the reason those numbers are worth citing at all. What
remains is not only deployment
engineering: the distributed ceremony (PO-14), the concession half of the
escalation authority (§6.2), and the settlement-binding constructions
(§9.2, PO-15/PO-16) are protocol work, alongside the independent auditing and
external replication this paper cannot supply. Three obligations are newly
registered here (PO-16, PO-17, PO-18 — attribution is detective), and the
settlement binding that v1 leaves to the host is PO-15. Rounds 29–31 registered
no new obligation codes: they re-attacked, they shipped three fixes (a
challenger-bound bond, a bounded inbox provenance, a per-round bond), and they
left their residuals where residuals belong — named, graded, and owned, in the
round documents (App. A, S-17, S-18, S-21).

---

## References

1. C. Komlo, I. Goldberg. *FROST: Flexible Round-Optimized Schnorr Threshold
   Signatures.* **SAC 2020** (Selected Areas in Cryptography, LNCS 12804);
   IACR ePrint 2020/852. (The standardized form is RFC 9591 [11].)
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
13. T. Dryja. *Discreet Log Contracts.* 2017 (the DLC oracle construction:
    pre-committed nonce, one signature per outcome, pre-signed execution
    transactions).
14. UMA Protocol (Risk Labs). *Optimistic Oracle* and *Optimistic Oracle v3*
    specifications, 2020–2023.
15. J. Peterson, J. Krug, M. Zoltu, A. Williams, S. Alexander. *Augur: A
    Decentralized Oracle and Prediction Market Platform.* 2015
    (arXiv:1501.01042).
16. Chainlink Labs. *Off-Chain Reporting (OCR2) Protocol Specification*, 2021;
    L. Breidenbach et al. *Chainlink 2.0: Next Steps in the Evolution of
    Decentralized Oracle Networks*, 2021.
17. T. Ruffing, V. Ronge, E. Jin, J. Schneider-Bensch, D. Schröder.
    *ROAST: Robust Asynchronous Schnorr Threshold Signatures.* ACM CCS 2022.
18. Kleros. *Yellow Paper* (juror incentives, appeal fees, and the ERC-1497
    evidence standard), 2019.
19. E. Crites, J. Katz, C. Komlo, S. Tessaro, C. Zhu. *On the Adaptive Security
    of FROST.* CRYPTO 2025 (IACR ePrint 2025/1061) — FROST's fully adaptive
    security under the low-dimensional vector representation (LDVR) assumption.
20. CVE-2025-58359 — ZF FROST: the `frost_core::keys::refresh` path accepted a
    reduced `min_signers` without validation, which did **not** lower the
    threshold (signing at the smaller threshold still failed) but did reduce the
    security of participants' shares; fixed in 2.2.0 (2025), which validates the
    parameter. The refresh invariant of §10.2 D exists because of this failure
    class, not because the group threshold silently moved.

---

## Appendix A. Artifact provenance and audit record

This appendix carries everything that is *about* the artifact rather than
about the protocol: where each normative document lives, which proof backs
which theorem, what the reviewers' finding codes referred to, how to regenerate
each number, and what the review record does and does not include. The body
cites these entries as `(App. A, S-n)`, `T-n`, or `A.n`.

### A.1 Normative documents

| ID | Document | Path |
|---|---|---|
| S-1 | Settlement binding (three bindings, cohort-lifetime rule) | `docs/SETTLEMENT-BINDING.md` |
| S-2 | Complaint protocol (possession-bound, victim-authored) | `docs/COMPLAINT-PROTOCOL.md` |
| S-3 | Universal-confirmation design proposal | host repository `bao.markets`: `docs/proposals/UNIVERSAL_JURY_CONFIRMATION.md` |
| S-4 | Escrow and slashing | `docs/ESCROW-SLASHING.md` |
| S-5 | Settlement rails (Lightning, Liquid) | `docs/SETTLEMENT-RAILS.md` |
| S-6 | Review register and open-obligation register (PO-1…PO-18) | `docs/REVIEW_SIMULATION.md`; `docs/THREAT_MODEL.md` §6 |
| S-7 | Cryptographic literature audit (mechanisms as used) | `docs/CRYPTO_AUDIT.md` |
| S-8 | Invariant reference (INV-*, extracted from the guards) | `docs/FORMAL_INVARIANTS.md` |
| S-9 | Threat model (adversary classes, attack tree, residuals) | `docs/THREAT_MODEL.md` |
| S-10 | Evaluation chapter | `docs/EVALUATION.md` |
| S-11 | Reproducibility contract | `docs/REPRODUCIBILITY.md` |
| S-12 | Claim-to-evidence cross-check ledger | `docs/CROSS_CHECK.md` |
| S-13 | Performance baseline (methodology, full tables, repro log) | `docs/benchmarks/BASELINE.md`, `baseline-medians.json`, `repro-log-2026-11-10.txt` |
| S-14 | Module map | `README.md` §10 |
| S-15 | Economics gap-fills (capture probability, per-rail cost of corruption, P+ε, seed-grinding bound, √k stake splitting — the external reviews' quantitative asks, each with derivation and residual) | `docs/proofs/economics/05-review-gapfills.tex.md`; numbers reproducible from `scripts/review-quant/economics.mjs` |
| S-16 | Attributable signing (session journal, RFC 9162 log, batch-signing duty) | `docs/ATTRIBUTABLE_SIGNING.md` |
| S-17 | Review round 3 — attacking the fixes that round 2 shipped (r29-1…r29-10, grading rule, residuals) | `docs/REVIEW_ROUND_3.md` |
| S-18 | Per-round escalation bonds (v0.13.0 consumption test, compatibility matrix, derived cap and flip round) | `docs/PER_ROUND_BOND.md` |
| S-19 | Multi-process ceremony (N real OS processes, chaos kill/replay, Byzantine-relay modes incl. split-view, and the honest scope of what it proves) | `docs/MULTI_PROCESS_CEREMONY.md` |
| S-20 | Statistical corpora (nine campaigns) + the witness-aware model-check tables | `docs/benchmarks/SCALE_CAMPAIGN.md`; `docs/benchmarks/campaign-2026-11-11.json` |
| S-21 | Economic expert re-verify of the post-fix layer (r30-1…r30-5: bond consumption, churn cap, κ slack, decay pairing) | `docs/proofs/economics/06-expert-verify.tex.md`; numbers reproduced by `scripts/review-quant/economics.mjs` §6 |
| S-22 | Three-day fault-injected soak (30,000 settlements, 32/32 assertions, SOAK-F7/F8/F11) | host repository `bao.markets`: `docs/benchmarks/SOAK_3DAY.md`, `docs/benchmarks/soak-3day.json` |

### A.2 Proofs and machine-checked artifacts

| ID | Result | Artifact |
|---|---|---|
| T1 | Encoding injectivity and per-schema prefix-freeness | `docs/proofs/01-encoding.tex.md` |
| T2 | Merkle soundness (completeness unconditional; soundness under SHA-256 CR + Schnorr EUF-CMA) | `docs/proofs/02-merkle-soundness.tex.md` |
| T3 | Tally well-definedness (verdict as a function of the reveal multiset; strict total tie-break) | `docs/proofs/03-tally.tex.md` |
| T4 | Machine safety for all roster sizes (structural induction over event sequences) | `docs/proofs/04-machine-safety.tex.md` |
| T5 | Attestation soundness (pipeline direction unconditional; verification direction under Schnorr/FROST premises) | `docs/proofs/05-threshold-soundness.tex.md` |
| T6 | Signing-session attribution (the bare aggregate is unlinkable; the journal reconstructs and attributes it) — conditional on the certified-share pin (P1) and authenticated append-only entries (P2) | `docs/proofs/attribution.tex.md` |
| — | Premise registry (J1, E1–E2, H-JS1/2, S1–S5), lemma gaps (GAP-5a: dependency fidelity, probe-pinned not source-verified) | `docs/proofs/README.md` |
| — | Protocol-level games: DEF-1…DEF-4 (`ATTFORGE`, `VERDICTCONS`, `CHAINFORGE`, `CONFLIVE`), THE-1…THE-4, residuals and GAP-20a/b | `docs/proofs/security/` |
| — | Economics layer proofs | `docs/proofs/economics/` |
| — | Independent second model of the vote/confirmation machines (Quint 0.33.1 + Apalache): 42 scenario tests, 10 000 seeded simulation runs per machine with all invariants checked per state, and a bounded symbolic check to depth 10 — no violation; committed run log. **Outside the one-command reproduce contract** (needs `quint` + Java 21) | `proofs/mechanized/court.qnt`, `run.sh`, `quint-run.log`, `README.md` |
| — | Lean 4 mechanisation of single finality (`oracle_single_finality`, `machine_final_certified_unique`, `finalize_barrier`, `machine_alone_insufficient`): build clean with no `sorry`, axiom audit limited to `propext`/`Quot.sound`; the signature scheme is *abstracted* (`Signed` is uninterpreted), so this checks the finality machine, not the cryptography. **Outside the reproduce contract** (needs `lean`/`elan`) | `proofs/lean4/SingleFinality.lean`, `Axioms.lean`, `run.sh`, `lean-run.log`, `README.md` |
| — | Exhaustive model-check fixture (15 instances, 3,869,232 states, 60,020,684 illegal-witness probes, 0 accepted) and its generator | `__fixtures__/model-check-summary.json`; `scripts/model-check.mjs` |
| — | Witness-aware model-check tables and the nine-campaign statistical corpora | `docs/benchmarks/SCALE_CAMPAIGN.md`; `docs/benchmarks/campaign-2026-11-11.json`; `scripts/campaign/run-campaign.mjs` |
| — | Multi-process ceremony (N = 3…7 OS processes, kill/replay chaos, Byzantine-relay split-view/loss/reorder/replay/silence matrix) | `scripts/court/multi-process-ceremony.mjs`, `scripts/court/juror-child.ts`; gated by `__tests__/r30MultiProcessCeremony.test.ts`, `__tests__/r33ByzantineRelay.test.ts` |
| — | Escalation-witness and per-round-bond pins | `__tests__/reviewRound3.test.ts`, `__tests__/escalationWitness.test.ts`, `__tests__/perRoundBond.test.ts`, `__tests__/ladderEconomics.test.ts`, `__tests__/penaltyAging.test.ts` |
| — | Transport/seal/MLS suite | `__tests__/r30SealGames.test.ts`, `__tests__/r30MarmotTransport.test.ts`, `__tests__/r30InboxOutboxLoad.test.ts` |
| — | Differential-parity suite and its restatements | `__tests__/differentialParity.test.ts`; `__tests__/reference/` |
| — | Whole-court simulation | `__tests__/simulateCourt.test.ts` (`npm run simulate:court`) |

### A.3 Finding codes referenced by this text

The body names each finding in prose; this table is the mapping to the codes
used in the repository, so that a reader can follow the trail without the codes
cluttering the argument.

| Code | Finding | Disposition |
|---|---|---|
| F-2 | A present-but-empty policy pin was silently accepted | Fail-closed: empty pin invalid (§7.3); `docs/FORMAL_INVARIANTS.md` |
| F-3 | A restored confirmation/outcome ledger could direct clawbacks at arbitrary indices | Ledger barrier re-derived at `resolve_round` and `finalize` (§6.1); `docs/FORMAL_INVARIANTS.md` |
| F-12 | Stale-timestamped events could be replayed into a restored snapshot | Monotonic clock ledger in all four machines (§6.4) |
| F-13 | "No single party can release" did not describe the shipped host-mediated rail | Corrected statement of the binding (§1.2, §3.2, §12.6); `docs/SETTLEMENT-BINDING.md` |
| A-1 | Signer-set freeze vs distinct commitment set in the signing machine | Invariant in the model-checked bundle (§11.2) |
| C-2 | Composite-SLA consumption obligations (threshold above the 0.5 floor; participation definition) | Stated as host duties (§7.4) |
| A-3 | "Formalized adversaries" family was described as exhaustive | Wording corrected in `docs/EVALUATION.md` |
| r29-1 | The escalation bond was bound to the **case**, not the **challenger**: a juror holding no bond could escalate on a bonded juror's accepted hash, and the audit log named the wrong person (§10.2 P) | Challenger binding in the reducer (`challenge.idx === challengerIdx` ∧ hash); INV-ESC-5 restated; the model-check property corrected — it had mirrored the weak check (S-17) |
| r29-2 | The escalation witness log had no tamper barrier: a restored snapshot could append a fabricated record and finalize on it | `assertValidEscalationLog` re-derived at `finalize`; INV-ESC-8 (S-17) |
| r29-3 | One accepted challenge bond funded **every** round of the same case | Re-graded MAJOR economically by r30-1 and closed by per-round consumption in v0.13.0; the legacy membership semantics remain the compatibility default (S-18, S-21 §1) |
| r29-10 | A vacuous test ceiling: a mutant returning `Number.POSITIVE_INFINITY` passed all 23 budgeted tests | The budget helper is pinned — default, junk fallback, override, and ordering (§11.1) |
| r29-7 / r29-8 | The economic cap measured a client-declared creation liquidity and was never re-assessed; the ladder depth was read live from env after the cap froze | Closed host-side: server-side exposure basis and per-market ladder freeze; what the fix leaves is r30-2 (S-17, S-21 §2) |
| r30-1 | The ladder bond was a **membership** test, not a consumption test: $\Delta C_{r+1} = 0$, so escalation was a free option worth 363 $b_0$ | Per-round bond witness + consumption rules, v0.13.0; INV-ESC-9; restored-snapshot re-derivation (S-18, S-21 §1) |
| r30-2 | A frozen ladder configuration is a *ceiling*: the panel a cohort can actually seat is $\min(N_{\text{cfg}}, \text{drawable})$, so 135→45 seats is 2.47× short of its own invariant | Host: cap re-derived at the effective $N$, `min(cap at creation, cap now)`, `cap_degraded` flag; a concession is never blocked (S-21 §2) |
| r30-3 | The prompt's premise was wrong: a weaker-than-supermajority quorum **tightens** the cap ($\kappa_q = 2.75$–$4.64$), so the correction is slack, not exposure | Premise corrected in the paper; no code change; **SAFE** (S-21 §3) |
| T-1 | Provenance overflow: a wrap delivered by 65+ relays produced a snapshot the restore path must reject, so the **whole** durable inbox was unrestorable — triggerable by a hostile relay set without any key | Provenance capped at the first 64 distinct sources by delivery order; `lastSeen` still advances; restore stays strict (§11.7) |
| MC-F7 | A variant instance whose state space equals its base's is not exercising what it claims | Instance repaired (19,822 → 116,906 states) (§11.2) |
| MC-F8 | All-digit witness fixtures made the "uppercase hex" probe a no-op | Fixtures carry hex letters; the illegal-witness assertion catches the class (§11.2) |
| SOAK-F7 | The reconcile replay overlap is a re-*serve* window, not a delivery-delay bound: 8 of 184,620 acks were silently lost across a long partition | Lagged cursor watermark (one overlap behind `now`) (S-22) |
| SOAK-F8 | The one-day soak had been **red on `main` for two protocol rounds** (an unwitnessed `escalate` against the v0.12 vendor); nothing re-ran it on protocol changes | Soak drives the real §9.2 witness path; unmodified `main` re-measured at 11/17 assertions, 289 stuck cases (S-22) |
| SOAK-F11 | A ladder rung that re-draws an already-served juror inserts nothing against the `(case, juror, kind)` unique key — no error, no alert | Fresh-draw tracking + the `ack_no_silent_loss` assertion (S-22) |

**Finding codes are namespaced per artifact**, deliberately: `F-2`, `F-3`,
`F-12`, `F-13` and `A-1`/`A-3` are the formal-invariant and editorial rounds;
`MC-F7`/`MC-F8` are the model checker's own fixture defects; `SOAK-F7`/`F8`/`F11`
are the soak's; `r29-*`/`r30-*` are review-round findings; `T-1` is the transport
campaign. The paper names each with its namespace so that two unrelated `F7`s
never read as one finding — a provenance defect the round-23 paper check did
find in an earlier draft.

Statement corrections applied to this text in the 2026-11-10 editorial round,
recorded here rather than in the body: "structurally invalid" → "publicly
detectable, with the detection procedure" (§3.3); "independent reimplementations"
→ "in-house differential" (§11.3, §12.5); the privacy claim reconciled with the
`OP_CHECKMULTISIG` `M`,`N` disclosure (§1.2, §9.2); commit–reveal described as
stopping copying but not buying (§5); the $M-1$ / $N-M$ bounds stated together
(§1.2, §10.1); the complaint argument rewritten around what an outsider learns
from the public transcript (§2.4); the Lightning preimage's public
computability stated as an exposure (§9.1, §10.2 O); the selection formula
reconciled with the code, including 32-bit collisions, boundary clamping, and
cross-engine `Math.log` (§4.2); proactive refresh specified rather than
asserted (§10.2 D); the duplicate attack-vector label corrected (two vectors
were both "M"; the relay vector is now N). Version numbers, test counts,
finding codes and file paths were moved here from the body; the version
history itself is `CHANGELOG.md`.

### A.4 Artifact inventory and regeneration

| Artifact | Command / location | Count (2026-11-11, at `c456fb4`) |
|---|---|---|
| Test suite | `npm test` | 1,686 passing, 1 environment-gated live test skipped, 76 files (measured at `608e6dc`, round 34; the per-round pinned count is App. A.1, S-12 §1) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`, source + scripts + tests) | clean |
| Model-check sweep | `npx tsx scripts/model-check.mjs` | 15 instances, 3,869,232 states, 60,020,684 illegal-witness probes (0 accepted), 0 raw throws |
| Statistical corpora | `npm run campaign:full` | 9 campaigns, 1,187,000 units, 3,745,566 assertions, 0 failures (CI runs a fast subset) |
| Multi-process ceremony | `npm run simulate:multiprocess` | N = 3…7 OS processes; happy path + 2 kill points + replay (gated in CI) |
| Differential parity | `npx vitest run __tests__/differentialParity.test.ts` | 5 areas, seeded |
| Whole-court simulation | `npm run simulate:court` | deterministic, same-seed reproducible |
| Benchmarks | `npm run bench` / `-- --json` | 29 timed rows; two-run reproducibility pair |
| Reproducibility sweep | `scripts/reproduce.sh` | stages per `docs/REPRODUCIBILITY.md` |
| Claim ledger | `docs/CROSS_CHECK.md` | every paper claim → evidence |

Counts are point-in-time and are re-recorded per round in `docs/CROSS_CHECK.md`
§1; none of them is a correctness claim on its own.

### A.5 Review record

| Tier | Who | Scope | Record |
|---|---|---|---|
| In-house audit and symposium rounds | AI agents working in this repository, directed by the project | The implementation and its documents; findings landed as fixes, specs, or registered obligations | `docs/FIXES-2026-08-15.md`, `docs/FIXES-2026-08-18.md`, `docs/FIXES-2026-08-21.md`, `docs/REVIEW_SIMULATION.md`, `docs/CROSS_CHECK.md`, `docs/DRESS_REHEARSAL.md`, `docs/proofs/` |
| **Fix-and-re-attack rounds (29–31, 2026-11-11)** | AI agents working in this repository, attacking the *previous* round's shipped fixes with the reducer/route/env in hand | Escalation witness and its bond binding, per-round consumption, budget vacuity, transport provenance, inbox/seal/MLS games, the economic layer, and the soak's own staleness | `docs/REVIEW_ROUND_3.md` (S-17), `docs/PER_ROUND_BOND.md` (S-18), `docs/MULTI_PROCESS_CEREMONY.md` (S-19), `docs/proofs/economics/06-expert-verify.tex.md` (S-21), §11.6 |
| Multi-agent editorial audit, three rounds (2026-11-10) | Parallel review agents, each assigned a section | Assurance framing, related work, provenance hygiene, statement corrections, disclosure, scope | This document (§11.5) and App. A.3 |
| External AI reviews (2026-11-10) | GPT, Claude, Gemini | **Paper text only** — no code access, no execution, no cryptographic analysis, no formal verification | Verdicts applied in this revision |
| Independent human / third-party audit | — | Not performed | §12.5 remains open |

### A.6 Open obligations newly registered by this paper

| ID | Obligation | Why it is open | Closure path |
|---|---|---|---|
| PO-16 | Lightning panel has no secret input: any party can derive a hold's preimage once the verdict is public, so an incoherent juror's payment can be forced if the hold is still open (§9.1) | Panel A is social slashing by design; the release is attributable but not preventable | Host-held secret witness (makes the host a custodian of slashing claims) or migrate the economic layer to the script-enforced panel |
| PO-17 | Cross-engine selection ordering: `Math.log` is not required to be bit-identical across ECMAScript engines, so near-ties in $-\ln(r)/\sqrt{w}$ can in principle order differently on two conforming verifiers (§4.2) | The 32-bit draws are reproducible and a divergence is detectable, but bit-exact ordering is not established | Compare priorities with a documented exact/rational method (or publish the computed priorities and pin a tolerance + tie-break), or replace the transcendental with a fixed-point transform |

Both rows are registered in the obligation register (App. A.1, S-6) and
restated here with their closure paths, so that the paper never cites an
obligation it has not registered.

**Rounds 29–31 registered no new obligation codes**, and that is a deliberate
choice rather than an omission: what those rounds produced are *engineering*
residuals with named owners and closure points, not paper-level proof
obligations. They are graded and recorded in the round documents — r29-3…r29-8
and r29-10 in S-17, r30-1…r30-5 in S-21, T-1 in §11.7, SOAK-F7/F8/F11 in S-22 —
because an obligation code that never closes is worse than a residual with a
date on it. Two of them were reachable in the host deployment and are already
closed there (r29-7/r29-8 → server-side exposure basis and per-market ladder
freeze; r30-2/r30-5 → effective cohort size, `min(cap)`, quorum-aware κ), which
is also why §12.8 lists the economic layer as a *gate* on the host rather than
as evidence shipped here.
