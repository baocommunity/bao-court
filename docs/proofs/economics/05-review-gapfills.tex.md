# The Review Gap-Fills — capture probability, cost-of-corruption per rail, P+ε, seed grinding, and the √stake splitting result

**Round:** symposium review-response round. Five quantitative gaps named by three
external reviews of the proof set (`docs/proofs/economics/00–04`) are closed
here: three with exact numbers, one with a corrected inequality, one with a
proof plus a correction to the paper's own anti-plutocracy claim.
**Status:** every table below is computed by
`node scripts/review-quant/economics.mjs` (exact BigInt rational arithmetic;
no dependencies, no network) — the numbers are reproducible, not asserted.
**Premises:** the game of [`00-model.tex.md`](00-model.tex.md) (players, A1–A9,
closed-budget lemma L-0). Nothing here changes an assumption; where a gap
needed one, it is added to this file's own ledger (§7) rather than hidden in
`00-model`.

Sibling files: [`01-farming`](01-farming.tex.md), [`02-ladder`](02-ladder.tex.md),
[`03-collusion`](03-collusion.tex.md), [`04-goodhart`](04-goodhart.tex.md).

---

## 0. Reviewer attribution — what was asked, and what the answer turned out to be

The numbering below is the review round's own item numbering, preserved so a
reviewer can check that their point was actually answered. **Two of the
reviewers' figures are confirmed to their stated precision; one is corrected
(P+ε); one is sharpened in the mechanism's disfavour (√stake); one is
strengthened (cost-of-corruption: the Lightning rail cannot satisfy the
condition at all).**

| § | Reviewer item | Reviewer's claim | Verdict of this file |
|---|---|---|---|
| 1 | **Claude #5** — jury-capture probability table | N ∈ {15,45,105,201} at ⌈2N/3⌉; sanity: ⅓ weight at N=15 ≈ **0.9%**, at N=45/t=30 ≈ **0.0005%** | **CONFIRMED.** Exact values 0.850427% and 0.00050011%. Both reviewer figures are right to their stated precision. Table extended to the *actually shipped* ladder panels (5/15/45/135/405) and to the round-0 quorum, where the answer is much worse than the reviewers assumed (§1.3). |
| 2 | **Claude #4 + Gemini A** — cost of corruption per rail | "State $V_{\max}$ per rail; condition (i) holds only where colluders have at-risk capital; propose the market-cap invariant $V_{\max} \le \gamma \sum S_i$" | **STRENGTHENED + IMPLEMENTED.** Per-rail $V_{\max}$ derived and tabulated (§2.2–2.4); the Lightning rail has $\gamma = 0$, so the invariant is *unsatisfiable* there and the reduction must be a value cap, not a capital cap (§2.5). The collateral invariant **fails at the shipped round-2 panel** (0.45·V) and first holds at round 3 (1.35·V) — a new, actionable finding (§2.6). |
| 3 | **Claude #4 + Gemini A** — P+ε / bribery asymmetry | "A promise to compensate only on losing makes a successful bribe cost ε; pure-pay rails cannot resist it" | **CORRECTED, then confirmed in the limit.** The exact expected cost is $\max(0,\,1-2\pi)\cdot X$ per juror — a *discount factor*, not a constant: $X$ at $\pi = 0$, $0.1X$ at $\pi=0.45$, and **exactly zero for every $\pi \ge \tfrac12$**. So "costs ε" is right in the strong-cartel limit and wrong for weak cartels, where the attack pays full price. The pure-pay-rail half of the claim is **confirmed and proved** (§3.4). |
| 4 | **Claude #2** — seed-grinding honest bound | "The lottery seed's block-withholding attack costs one block reward; state the real bound, the fix (fix the seed block height after candidate freeze), and the residual" | **BOUND PROVED.** Viability $V > R_{\text{blk}}/\Delta P$ with $\Delta P \le \Pr[X = t-1]$; the honest table says grinding needs a **2.2·10¹⁰ sat (223 BTC) dispute** in the most attacker-favourable shipped configuration — **≥ 220×** above any BAO market (§4.3). The proposed fix is *ordered* here in the only form that works, and its residual (the seed-block miner's one-block option) is named as irreducible by the multi-block beacon (§4.4). |
| 5 | **Claude #3** — √stake splitting | "Splitting stake $w$ across $k$ identities yields $\sqrt{k}$ weight gain — prove it, and align the paper's anti-plutocracy claim" | **PROVED, AND THE PAPER CORRECTED.** The $\sqrt{k}$ gain is one line of algebra (§5.2); the ceiling is set by the 1 %-of-volume gate, and *at the ceiling the weight becomes **linear** in stake* — the quadratic concavity is an artefact of indivisible identity, so §4.2 of the paper's "anti-plutocracy" sentence is **false in the saturated regime** and is rewritten in this PR (§5.5). |

---

## 1. Jury-capture probability (Claude #5)

### 1.1 The draw model, stated

The reviewers' model, adopted explicitly because it is the *conservative*
(attacker-favourable) one:

> **Model D (weight-proportional independent draw).** The pool's total
> selection weight is 1; an adversary (a colluding cartel, or one whale)
> controls weight fraction $\rho$. Each of the $N$ seats is filled
> independently with an adversary-controlled juror with probability $\rho$,
> with the seat count capped at $N$. Hence
> $X \sim \operatorname{Bin}(N, \rho)$ and the panel is **captured** iff
> $X \ge t$ with $t = \lceil 2N/3 \rceil$.

Justification and honest caveats, in order:

1. **This is exactly the shipped mechanism's own law.** The draw is an
   exponential race with rate $w_j$ (`selection.ts:221–229`, `weightedPriority`;
   default rate $\sqrt{\text{stake}}$ at `:204–209`), so per-seat probability is
   $w_j/\sum_k w_k$ — the "weight-proportional" half of Model D is code-pinned
   (paper §4.2's Proposition, proved there). Independence across seats is the
   *approximation*: the shipped draw is sampling **without replacement**, so
   the honest law is hypergeometric at the same mean.
2. **Without replacement is thinner-tailed than with replacement** at a fixed
   mean (variance factor $(M-N)/(M-1) < 1$ for a pool of size $M$). We
   therefore **do not take credit for the correction**: every number below is
   the binomial, i.e. an upper bound on the true capture probability, with the
   gap $O(N/M)$ — at the spec's active set $A \approx 50$ (spec L223) and
   $N = 15$ that gap is not negligible in principle, but it *favours the
   mechanism*, so using the binomial errs on the side of the attacker.
3. **$\rho$ is not the same as "bribable".** A weight fraction can be captured
   either by *owning* the weight (a whale, or a cartel of whales) or by
   *bribing* it (Theorem 3). Model D prices the first; §2–3 price the second.
   The two compose by substituting the bribe-cleared weight fraction for $\rho$.

### 1.2 The exact tail and the table

For a fixed $(N, t, \rho)$ the capture probability is the binomial upper tail

$$\Pr[\text{capture} \mid N,t,\rho] \;=\; \sum_{k=t}^{N} \binom{N}{k}\rho^{k}(1-\rho)^{N-k},
\qquad t = \Big\lceil \tfrac{2N}{3} \Big\rceil , \tag{5.1}$$

computed exactly as a rational with denominator $q^{N}$ for $\rho = p/q$. The
requested table ($\rho$ as the adversary's weight share; all values exact to
four significant figures):

| $N$ | $t=\lceil 2N/3\rceil$ | $\mathbb{E}[X]$ at $\rho = 1/3$ | $\rho = \tfrac13$ | $\rho = 0.40$ | $\rho = 0.45$ | $\rho = 0.49$ |
|---|---|---|---|---|---|---|
| 15 | 10 | 5.00 | **8.504·10⁻³** (0.8504 %) | 3.383·10⁻² | 7.693·10⁻² | 1.333·10⁻¹ |
| 45 | 30 | 15.00 | **5.001·10⁻⁶** (0.000500 %) | 2.708·10⁻⁴ | 2.778·10⁻³ | 1.273·10⁻² |
| 105 | 70 | 35.00 | **3.167·10⁻¹²** | 3.089·10⁻⁸ | 6.247·10⁻⁶ | 1.932·10⁻⁴ |
| 201 | 134 | 67.00 | **5.359·10⁻²²** | 2.104·10⁻¹⁴ | 4.960·10⁻¹⁰ | 3.207·10⁻⁷ |

**Sanity check against the reviewer.** Both figures are right:

- $\rho = 1/3$, $N = 15$, $t = 10$: the reviewer said "~0.9 %". Exact:
  $122{,}027 / 14{,}348{,}907 = 0.00850427\ldots = \mathbf{0.8504\,\%}$. The
  reviewer's rounding is conservative by 6 % relative — negligible, and in the
  mechanism's disfavour, so accepted as stated.
- $\rho = 1/3$, $N = 45$, $t = 30$: the reviewer said "~0.0005 %". Exact:
  $\mathbf{5.0011\cdot 10^{-6}} = 0.00050011\,\%$. Match to every quoted digit.

No correction is needed. The table's *value* is the middle-right column: the
reviewers' design question was "how big must the panel be", and the answer
depends violently on $\rho$. **A 0.49-weight adversary — just under half —
captures a 45-seat panel 1 in 79 disputes and a 15-seat panel 1 in 7.5.** A
0.45-weight adversary captures the round-1 panel (15 seats) 7.7 % of the time.

### 1.3 The actually-shipped panels, and where the real capture risk sits

The requested $N$ values (105, 201) are **not shipped rungs**. The paper's
ladder is $n_0 = 5$, $n_1 = 15$, $n_2 = 45$, $n_3 = 135$, $n_4 = 405$
(paper §6.2; `00-model.tex.md` §5.3, $n_r = 5\cdot 3^r$). Recomputing on the
shipped set, plus the round-0 quorum question:

| Panel | $t$ at $\lceil 2N/3\rceil$ | $\rho = 1/3$ | $\rho = 0.40$ | $\rho = 0.45$ | $\rho = 0.49$ |
|---|---|---|---|---|---|
| $n_0 = 5$ (round 0) | 4 | 4.527·10⁻² | 8.704·10⁻² | 1.312·10⁻¹ | 1.752·10⁻¹ |
| $n_1 = 15$ | 10 | 8.504·10⁻³ | 3.383·10⁻² | 7.693·10⁻² | 1.333·10⁻¹ |
| $n_2 = 45$ | 30 | 5.001·10⁻⁶ | 2.708·10⁻⁴ | 2.778·10⁻³ | 1.273·10⁻² |
| $n_3 = 135$ | 90 | 2.735·10⁻¹⁵ | 3.571·10⁻¹⁰ | 3.197·10⁻⁷ | 2.559·10⁻⁵ |
| $n_4 = 405$ | 270 | 1.283·10⁻⁴² | 2.292·10⁻²⁷ | 1.321·10⁻¹⁸ | 5.412·10⁻¹³ |

Two findings that the reviewers' $N$-set could not surface:

> **Finding 1.1 (the ladder is the defence, round 0 is the exposure).** The
> shipped round-0 quorum is **3 of 5** — a *0.600* threshold, below the
> $\lceil 2N/3 \rceil$ standard the threat model itself names (PO-1,
> `THREAT_MODEL.md` §6 PO-1). At 3-of-5 the capture probability is
> **0.2099 at $\rho = 1/3$** and **0.4813 at $\rho = 0.49$** — versus
> 0.0453 / 0.1752 at the 4-of-5 that $\lceil 2N/3\rceil$ prescribes. **A
> 4.6× and 2.7× gap, on the panel that decides every undisputed case.** The
> ladder only helps a victim who rationally escalates (Theorem 2), so a
> captured round 0 that nobody contests is the cheapest capture in the system —
> which is exactly Theorem 3.1's weak-victim row, now with a number.

> **Finding 1.2 (the code default is a host hazard).** `confirmQuorum` is a
> caller parameter whose **code default is 1**
> (`courtConfirmationMachine.ts:223`: `params.confirmQuorum ?? 1`, validated
> only into $[1, \text{roster}]$). A host that omits it gets a one-confirmation
> round 0. At $N = 5$ and $\rho = 1/3$ the capture probability is then
> **0.8683**; at $\rho = 0.49$ it is **0.9655**. The spec's 3-of-5 is a host
> duty, not a code guarantee — the same class of gap as C-2's $\tau$. The full
> quorum sweep:

| $N = 5$, $\rho$ | $q=1$ | $q=2$ | $q=3$ | $q=4$ | $q=5$ |
|---|---|---|---|---|---|
| ⅓ | 0.8683 | 0.5391 | 0.2099 | 0.04527 | 0.004115 |
| 0.49 | 0.9655 | 0.7998 | 0.4813 | 0.1752 | 0.02825 |

`00-model.tex.md` §3 should therefore be read as *spec-pinned 3-of-5 with a
code default of 1* — an honest-parameters correction carried into that file in
this PR.

### 1.4 Minimum panel size vs market value (the guidance the reviewers wanted)

"Which $N$ for which market?" has **two legs**, and they have different shapes.

**Leg A — the capture leg.** Fix the operator's tolerated capture probability
$\varepsilon_{\text{cap}}$ and the worst admissible adversary share $\rho$.
Solve (5.1) for the smallest $N$:

| $\varepsilon_{\text{cap}}$ | $\rho = 1/3$ | $\rho = 0.40$ | $\rho = 0.45$ | $\rho = 0.49$ |
|---|---|---|---|---|
| 10⁻³ | 20 | 32 | 50 | 74 |
| 10⁻⁴ | 29 | 47 | 74 | 110 |
| 10⁻⁶ | 50 | 77 | 119 | 179 |
| 10⁻⁹ | 77 | 125 | 188 | 284 |
| 10⁻¹² | 107 | 170 | 260 | 389 |

**Leg B — the capital leg** (§2's cost-of-corruption inequality): the disputed
value must not exceed the colluders' own exposure, i.e.
$V \le \gamma \sum_{\text{colluding}} S_i$. With $\gamma = \alpha p_{\text{flip}} = 0.5$
and the shipped stake schedule $s = \max(0.02\,V_m,\ 5{,}000)$
(`escrow.ts:133–155`), this leg requires

$$N \;\ge\; \frac{V}{\gamma\,s} \;=\;
\begin{cases} \dfrac{1}{\gamma\sigma} = 100 & \text{proportional regime } (0.02V_m \ge 5{,}000),\\[2mm]
\dfrac{V}{2{,}500\ \text{sats}} & \text{floor regime } (V_m < 250{,}000). \end{cases}$$

**Combined guidance** ($\varepsilon_{\text{cap}} = 10^{-6}$, worst-case
$\rho = 0.49$):

| Disputed value $V$ | Leg A (capture) | Leg B, proportional stake | Leg B, floor stake | **Binding $N$** |
|---|---|---|---|---|
| 100,000 sats | 179 | 100 | 40 | **179** |
| 250,000 sats | 179 | 100 | 100 | **179** |
| 1,000,000 sats | 179 | 100 | 400 | **400** |
| 10,000,000 sats | 179 | 100 | 4,000 | **4,000** |

> **The rule, plainly.** *With proportional stakes, panel size is set by the
> capture target and is **independent of market value** (100 seats at
> $\gamma = 0.5$, $\sigma = 0.02$); with floor stakes it must grow **linearly**
> with market value (1 seat per 2,500 sats of disputed value).* The shipped
> schedule already is proportional above 250k sats, so the mechanism's real
> defect at scale is not the stake formula but that **no shipped rung reaches
> the 179-seat capture target**: the deepest is 135 seats, which meets
> $\varepsilon = 10^{-6}$ for $\rho \le 0.45$ ($3.20\cdot10^{-7}$) but not at
> $\rho = 0.49$ ($2.56\cdot10^{-5}$ — 25× above target).

## 2. Cost-of-corruption inequality, per rail (Claude #4 + Gemini A)

### 2.1 The definition, and the condition the reviewers asked about

> **Definition 2.1 ($V_{\max}$).** For a rail $r$, panel size $N$, threshold
> $t$, per-seat stake schedule $s(V_m) = \max(\sigma V_m, s_0)$ and slash rate
> $\alpha$, $V_{\max}(r, N, t, s)$ is the largest disputed value for which a
> $t$-seat collusion is **strictly EV-negative**:
>
> $$V_{\max} \;=\; \sup\Big\{\, V \;:\; V \;<\; t\cdot b(V) \;+\; \kappa_0\,m \,\Big\},
> \qquad b(V) \;=\; p_{\text{flip}}\big(\alpha\, s(V) \;+\; \delta\, p_{\text{eject}}\, L_{\text{stream}}\big). \tag{5.2}$$

$b(V)$ is the per-colluder individual-rationality bribe floor of Theorem 3's
(IR) line, unchanged; $\kappa_0 m$ the coordination mass (A3); $p_{\text{flip}}$
the probability the bribed verdict is overturned by the honest ladder
(Theorem 2's escalation, $p_{\text{flip}} = 1-(1-a)^{R-r}$).

This is the formal content of the reviewers' **cost-of-corruption inequality**,
and it isolates the condition they wanted stated:

> **Condition (C-i) — the colluder-capital condition.** The inequality
> $V < t\,b(V)$ has teeth only if $b$ contains a term that grows with $V$ — i.e.
> only if each colluder has $\approx V/t$ of *its own* capital at risk, and that
> capital can actually be **seized**. Formally: the mechanism is
> *capital-bounded* iff $\alpha > 0$ **and** $s(V) > 0$, because that is what
> makes the right-hand side of (5.2) scale with $V$.

**Condition (C-i) holds on staked rails and fails on the Lightning rail. This
is not a modelling choice; it is in the rails' own contracts.**

### 2.2 The staked rail — Liquid P2WSH/Taproot escrow

Binds to: `liquidEscrow.ts:6` (ADR-001 Panel B — "juror stakes / challenger
bonds are locked in a Liquid P2WSH M-of-N multisig"), `liquidRail.ts:37`
(`SpendBranch = 'judge' | 'refund' | 'multisig_release' | 'multisig_slash'`),
`escrow.ts:93–96` ($\alpha_I = 0.5$, $\alpha_N = \alpha_D = 1$), `escrow.ts:147`
($s = \max(0.02V_m, 5{,}000)$). Seizure is an on-chain script branch: objective,
permissionless, and **not** the host's discretion.

With $\alpha = 0.5$, $\sigma = 0.02$, and (5.2),

$$V_{\max} \;=\; \frac{t\,p_{\text{flip}}\,\delta\,p_{\text{eject}}\,L_{\text{stream}}
\;+\;\kappa_0 m}{1 \;-\; t\,p_{\text{flip}}\,\alpha\,\sigma},
\qquad\text{valid while } t\,p_{\text{flip}}\,\alpha\,\sigma < 1. \tag{5.3}$$

**The denominator is the whole argument.** At $t\,p_{\text{flip}}\alpha\sigma \to 1$
the resistance region diverges: the colluders' own at-risk capital grows as fast
as the prize. With $p_{\text{flip}} = 1$ (verdict contested through the cap —
the mechanism-favourable case) the **crossover seat count is
$t^{*} = 1/(\alpha\sigma) = 100$ seats**, i.e. $N \ge 150$ at the $\lceil 2N/3\rceil$
rule. Beyond it, **no market value is capturable by *paying* jurors** — the
payment route is EV-negative at every $V$. (The *ownership* route of §1 is a
different attack and is not priced by this inequality: it needs no bribe at all,
which is why §1's table and §2's are both required.)

Worked table ($\delta p_{\text{eject}}L_{\text{stream}} = 33{,}250$ sats at
$\delta = 0.95$, $p_{\text{eject}} = 0.5$, $J = 3{,}500$ sats/epoch, A1/A7 —
the numerics of `03-collusion` §2; $\kappa_0 = 0$, the zero-κ region):

| $N$ | $t$ | $t\cdot p_{\text{flip}}\alpha\sigma$ | $V_{\max}$ (staked, proportional) | vs shipped rung |
|---|---|---|---|---|
| 5 | 4 | 0.04 | 138,542 sats | round 0 |
| 15 | 10 | 0.10 | 369,444 sats | round 1 |
| 45 | 30 | 0.30 | **1,425,000 sats** | round 2 (shipped max) |
| 105 | 70 | 0.70 | 7,758,333 sats | — |
| 135 | 90 | 0.90 | 29,925,000 sats | round 3 |
| 201 | 134 | **1.34 > 1** | **unbounded — bribery-proof at every $V$** | — |
| 405 | 270 | **2.70 > 1** | **unbounded — bribery-proof at every $V$** | round 4 |

Consistency with `03-collusion`: (5.3) is the *single-panel* form; Theorem 3.1's
$V^{*}$ table (157k / 752k sats) is the same inequality summed over the
$p_{\text{flip}}$-weighted ladder mass with $p_{\text{flip},r} =
1-(1-a)^{R-r}$ and $n_0 = 5$. They agree in structure and differ in the
aggregation, as they must: 03 prices *the cheapest attack* (the round-0-only
bribe), (5.3) prices *one panel captured and then contested*. Neither
supersedes the other; both are stated with their parameter.

### 2.3 The floor-stake regime

Below $V_m = 250{,}000$ sats the proportional term is inert ($0.02V_m < 5{,}000$)
and (5.3) degenerates to a **hard cap with no denominator**:

$$V_{\max} = t\big(\alpha s_0 + \delta p_{\text{eject}} L_{\text{stream}}\big)
= t \cdot 35{,}750\ \text{sats at } p_{\text{flip}} = 1 .$$

| $N$ | 5 | 15 | 45 | 105 | 135 | 201 | 405 |
|---|---|---|---|---|---|---|---|
| $t$ | 4 | 10 | 30 | 70 | 90 | 134 | 270 |
| $V_{\max}$ (sats) | 143,000 | 357,500 | 1,072,500 | 2,502,500 | 3,217,500 | 4,790,500 | 9,652,500 |

The floor regime is where **Gemini A's market-cap invariant is literally the
right object**: a fixed stake cannot scale with value, so the only lever is the
seat count, and the region of resistance is a straight line in $t$.

### 2.4 The Lightning rail — condition (C-i) **fails**

Binds to: `lnSettlement.ts:3–10` (ADR-001 Panel A) — *"juror stakes are held as
Lightning hold invoices … SETTLES for coherent jurors … and CANCELS for
incoherent / non-reveal / double-vote jurors (**denial of reward + reputation —
"social slashing"**)"* — and `escrow.ts:93–96`, whose $\alpha$ values are
**protocol-layer constants that the Lightning rail cannot enforce**: there is no
on-chain collateral, no script branch, no pre-signed seizure. A cancelled hold
returns the money to the *payer*; it takes nothing from the juror.

Formally $\alpha_{\text{LN}} = 0$, so (5.2) becomes

$$V_{\max}^{\text{LN}}(N, t) \;=\; t\,\delta\,p_{\text{eject}}\,L_{\text{stream}}
\;+\;\kappa_0 m ,$$

| $N$ | 5 | 15 | 45 | 105 | 135 | 201 | 405 |
|---|---|---|---|---|---|---|---|
| $V_{\max}^{\text{LN}}$ (sats) | 133,000 | 332,500 | 997,500 | 2,327,500 | 2,992,500 | 4,455,500 | 8,977,500 |

**This table is not a capital bound and must not be read as one.** Every sat in
it is *expected future fee income*, and the modelled mechanism is ejection from a
pool the juror can leave — a pseudonymous juror's participation constraint is
not a claim on its balance sheet (Theorem 3.2's hit-and-run case is exactly this
rail's default outcome). The honest reading:

> **Theorem 5.1 (rail separation).** Condition (C-i) of the cost-of-corruption
> inequality holds **iff** the rail can seize a colluder's own capital
> ($\alpha > 0$, $s > 0$, seizure objective and not host-discretionary). It
> holds on the Liquid escrow rail (Panel B) and **fails identically on the
> Lightning rail (Panel A)** and in phase-0 zero-stake reputation mode
> (`selection.ts` `weightFn`/`zeroStakeAllowed`, paper §4.4).
> On those rails $V_{\max}$ degenerates to the stream term, which is (i) not
> collateral, (ii) exit-evadable, and (iii) amortized to zero by a hit-and-run
> cartel (Theorem 3.2). Consequence: **the Lightning rail's bribery resistance is
> $\kappa_0 m$ and nothing else** — it is a reputational rail, and the economics
> must say so instead of quoting an escrow bound it cannot enforce.

### 2.5 Gemini A's invariant, in implementable form

Gemini A's proposal — $V_{\max} \le \gamma \sum_i S_i$ with $\gamma < 1$ — is
adopted, with $\gamma$ pinned to the rail's actual seizure arithmetic:

$$\boxed{\;V_{\max} \;\le\; \gamma \sum_i S_i, \qquad \gamma = \alpha\, p_{\text{flip}} \;}
\qquad\text{and}\qquad \gamma_{\text{LN}} = 0 . \tag{5.4}$$

Substituting the shipped schedule makes it a **two-regime rule**:

- proportional regime: $\gamma \sum_i S_i = \gamma\sigma N V \Rightarrow$ (5.4)
  is $1 \le \gamma\sigma N$, **scale-free** — it constrains $N$, not $V$, and
  holds iff $N \ge 1/(\gamma\sigma) = 100$ at $\gamma = 0.5$;
- floor regime: $\gamma \sum_i S_i = \gamma s_0 N$, so (5.4) is the explicit
  market cap $V_{\max} = \gamma s_0 N = 2{,}500\,N$ sats.

**Guardian arithmetic** (the operator's pre-flight check, per dispute):

1. Read $V$, the rail, $N$, $t$, $s$, $p_{\text{flip}}$.
2. Compute $\gamma = \alpha\,p_{\text{flip}}$; **refuse the case on a rail with
   $\gamma = 0$ above the policy cap** (Lightning: $V \le t\,\delta p_{\text{eject}}L$
   from §2.4; at $N = 45$ that is **997,500 sats** — a policy number, not a bound).
3. Require $\gamma\sum_i S_i \ge V$: **$2{,}000{,}000$ sats bonded for a
   $1{,}000{,}000$-sat dispute** at $\gamma = 0.5$.
4. If the check fails, the operator has exactly three moves: **raise $N$**
   (at $s = 0.02V$: 100 seats suffice for any $V$; at the 5,000-sat floor:
   400 seats for 1M sats), **raise $s$** (a top-up bond), or **cap $V$**.
   There is no fourth move — the alternative is to accept a dispute the
   colluders can profitably capture.

### 2.6 The finding this exposes at the shipped parameters

$$\frac{\gamma\sum_i S_i}{V} \;=\; \gamma\,\sigma\,N \;=\; 0.01\,N
\quad\Longrightarrow\quad
\begin{cases}
N = 45: & 0.45 \;\;(\textbf{invariant FAILS — by 2.2×}),\\
N = 135: & 1.35 \;\;(\text{holds}),\\
N = 405: & 4.05 \;\;(\text{holds, } 4\times\text{ margin}).
\end{cases}$$

> **Finding 2.2.** At the shipped round-2 panel (45 seats) the collateral
> invariant (5.4) **fails**: the largest bribe-justified capture is worth more
> than everything the colluders could lose. Round 3 (135 seats) is the **first
> rung where the invariant holds**, and round 4 is the first with margin.
> The mechanism currently resists round-2 capture only through the stream term
> — i.e. only through a *reputational* asset that Theorem 3.2 shows a
> hit-and-run cartel does not hold. **The shipped `maxLadderRounds = 2` cap
> therefore stops the ladder exactly at the rung where the capital argument
> starts working.** This is a design tension to resolve deliberately: either
> the cap rises to 3 for high-value disputes (Theorem 2 says $r^* \le 2$ for
> priors ≤ 270:1, so the escalation price is still rational for a confident
> victim), or per-market value gating (spec L118–119) must be tightened to
> enforce (5.4) at $N = 45$, i.e. caps markets at $0.45V$ of bonded stake —
> meaning **a top-up bond of $0.55V$ escrowed by the proposer** for every
> high-value dispute.

## 3. The P+ε attack — bribery asymmetry, formalized (Claude #4 + Gemini A)

### 3.1 The claim under test

> The reviewers' P+ε ("parasitic escrow"): a briber who promises compensation
> **only in the state where the bribed verdict loses** faces no cost when it
> wins, so a *successful* bribe costs $\varepsilon$ — and a pure-pay rail, having
> nothing to seize, cannot resist it at any $\varepsilon$.

The claim has two halves. Both are taken seriously below; the first is
**corrected** (the cost is a discount factor, not a constant), the second is
**proved**.

### 3.2 The payoff algebra — why the discount exists at all

Let $X$ be the per-juror *deviation magnitude*

$$X \;=\; \alpha s + \frac{P}{|C|} \;>\; 0, \tag{5.5}$$

the incoherent slash plus the coherent-share bonus the juror forgoes. With the
verdict's direction $d \in \{\text{truth}, \text{bribe}\}$ and the juror's vote
$v$, the shipped escrow makes a juror's payoff a function of **coherence**
$v = d$, not of truth (`escrow.ts:93–96`, `verifyRedistributionIntegrity`).
Consequently:

| | verdict = truth (bribe loses), prob $1-\pi$ | verdict = bribe (bribe wins), prob $\pi$ |
|---|---|---|
| honest vote ($v$ = truth) | $+\frac{P}{\lvert C\rvert}$ | $-\alpha s$ |
| bribed vote ($v$ = bribe) | $-\alpha s$ | $+\frac{P}{\lvert C\rvert}$ |

$$\mathbb{E}[\text{bribed}] - \mathbb{E}[\text{honest}]
= \pi X - (1-\pi)X = (2\pi - 1)X. \tag{5.6}$$

**The deviation gain is antisymmetric in the verdict.** That is the whole
mechanism of P+ε: taking the bribe does not add exposure — it *relocates* the
same exposure to the other branch. A bribe contract that promises $R$ only in
the losing branch is accepted iff

$$(2\pi-1)X + (1-\pi)R \;\ge\; 0
\;\Longleftrightarrow\;
R \;\ge\; \max\Big(0,\ \frac{1-2\pi}{1-\pi}\,X\Big),$$

so the briber's **expected** cost per contracted juror is

$$\boxed{\;\mathbb{E}[\text{cost}_{\text{P+}\varepsilon}] \;=\; (1-\pi)\,R \;=\;
\max\big(0,\ 1-2\pi\big)\cdot X\;} \tag{5.7}$$

— a **discount factor** $\max(0,1-2\pi)$, not a constant $\varepsilon$:

| $\pi$ (bribed verdict stands) | 0 | 0.25 | 0.40 | 0.45 | **0.50** | 0.90 | 0.99 |
|---|---|---|---|---|---|---|---|
| refund $R/X$ | 1.000 | 0.667 | 0.333 | 0.182 | **0** | 0 | 0 |
| **expected cost / $X$** | 1.000 | 0.500 | 0.200 | 0.100 | **0** | 0 | 0 |

> **Correction to the reviewers' figure.** "A successful bribe costs ε" is
> exactly right **for $\pi \ge \tfrac12$** — there the price is *zero*, not ε
> (the juror is strictly better off taking a free coin-flip upgrade). But for a
> weak cartel ($\pi < \tfrac12$) the attack pays a real fraction of full price:
> $0.5X$ at $\pi = \tfrac14$, the full $X$ at $\pi = 0$. So P+ε is not a
> uniform attack; **it is a bootstrapping attack whose price falls to zero
> exactly as the cartel becomes likely to win** — which is the multi-equilibrium
> structure the mechanism has to break.

### 3.3 The equilibrium condition that forbids P+ε on a staked rail

Two properties of the shipped mechanism are load-bearing, and only one is
currently implemented:

1. **$\pi$ is made small by the ladder.** $\pi$ is not one panel's capture
   probability — it is the probability the bribed verdict *survives every honest
   escalation*, i.e. $\pi = \prod_{r}\Pr[\text{capture round } r]$ over the
   rounds the victim rationally contests (Theorem 2 gives their number,
   Theorem 3.1 gives the product). This is why §1's table is the input to §3:
   at $N = 45$, $\rho = 1/3$, a *single* round has $\pi \approx 5\cdot 10^{-6}$,
   so (5.7) charges the cartel full price. **The ladder is the P+ε defence.**
2. **The exposure must be act-contingent, not outcome-contingent.** (5.7) is
   zero at $\pi \ge \tfrac12$ *because* the only cost is the outcome-conditional
   slash. The fix is a posted, unconditional forfeit $D$ per contracted juror —
   slashed on **evidence of coordination** (or on any delivered vote shown to be
   bribe-directed), regardless of who wins:

$$\boxed{\;\text{resistant} \iff V \;\le\; t\cdot\max\Big(0,\ D + \max(0,\,1-2\pi)\,X\Big) \;+\; \kappa_0 m\;} \tag{5.8}$$

> **Theorem 5.2 (P+ε resistance condition).** A rail resists the parasitic
> contract **iff** the resisting branch is priced unconditionally: with an
> act-contingent forfeit $D$ per contracted juror (forfeited on *delivery* of a
> bribe-directed vote, or on evidence of coordination — not on the verdict), the
> briber's minimum per-juror cost is $\max(0,\ D + \max(0,1-2\pi)X)$, so the
> resistance region is (5.8). Two readings, both load-bearing:
>
> - for $\pi \ge \tfrac12$ the discount term vanishes and the condition is
>   **$t\,D \ge V - \kappa_0 m$** — the aggregate act-contingent forfeit, alone,
>   must cover the disputed value;
> - for $\pi < \tfrac12$ the outcome-contingent slash contributes
>   $(1-2\pi)X$ per juror, so a rail with $D = 0$ resists only while
>   $t(1-2\pi)X \ge V - \kappa_0 m$ — and since $X = \alpha s + P/|C|$ is
>   bounded by the closed fee/stake budget (L-0), that fails for every
>   sufficiently valuable dispute.
>
> A rail whose only sanction is outcome-contingent (the shipped $\alpha_I$) has
> $D = 0$: **no resistance at all against a confident cartel**, and
> value-bounded resistance below $\pi = \tfrac12$.

*Proof.* From (5.6), a juror who posts $D$ forfeited on delivery and accepts a
contract paying $R$ only in the losing branch has net
$(2\pi-1)X + (1-\pi)R - D \ge 0$, so the cheapest accepted $R$ is
$\max(0, (D - (2\pi-1)X)/(1-\pi))$ and the briber's expected cost per juror is
$(1-\pi)R = \max(0,\ D + (1-2\pi)X)$. Multiply by $t$ seats and add $\kappa_0m$;
rearranging gives (5.8). ∎

**What this means for the deployed escrow, stated plainly:** the shipped
incoherent slash is *outcome*-contingent, so it is P+ε-neutral *by itself*. The
mechanism's actual resistance to a confident ($\pi \ge \tfrac12$) cartel comes
from (a) the ladder keeping $\pi$ astronomically small, (b) $\kappa_0 m$
(coordination cost, A3), and (c) the hit-and-run detection economics of
Theorem 3.2 — **not** from $\alpha_I s$. A proof-bond that doubles as an
act-contingent forfeit would be the missing $D$; it is a design change, not a
re-reading of the algebra.

### 3.4 The pure-pay rail: confirmed, and proved without reference to $\varepsilon$

> **Corollary 5.3 (P+ε defeats pure-pay rails unconditionally).** On a rail with
> $\alpha = 0$ (Lightning hold-invoice: "denial of reward + reputation —
> *social slashing*", `lnSettlement.ts:3–10`) equation (5.5) gives
> $X = P/|C|$ — the coherent-share bonus alone — and the stream term is
> exit-evadable (Theorem 3.2). Then (5.8) with $D = 0$ requires
> $t\max(0,1-2\pi)P/|C| \ge V$, which fails for every $V > tP/|C|$ — and
> $P/|C|$ is bounded by the *closed* fee budget (Lemma L-0), so **the bound is a
> fraction of the same $V$ it must defend**. Hence: **P+ε wins on the Lightning
> rail at any value above the fee mass, for $\varepsilon = 0$.**

This is the reviewers' claim, and it is not a criticism of the implementation —
`lnSettlement.ts`'s header is honest that its sanction is social. It is a
criticism of *quoting escrow economics for a rail that cannot escrow*. §2.4
already draws the consequence; this corollary is why it matters.

## 4. Seed grinding — the real honest bound (Claude #2)

### 4.1 The attack, precisely

The seed is $\text{seed} = \mathrm{SHA256}(\texttt{disputeEventId} \,\|\,
\texttt{blockHash})$ (`selection.ts:150–173`), where `blockHash` is a confirmed
Bitcoin block (paper §4.1, default 6 confirmations). The panel is a deterministic
function of the seed (§1.1). Therefore **whoever supplies the seed block's hash
can compute the resulting panel before the hash is public**, and may withhold:

1. mine block $B$ at the seed height $h^{*}$;
2. compute $\text{seed} = H(\text{id} \| H(B))$ and the panel from it;
3. if the panel is unfavourable, **withhold $B$**; the next block mined by
   anyone else becomes the seed → an independent re-draw;
4. repeat if it wins blocks again.

The forfeit per re-draw is exactly one block's reward plus its fees
$\approx R_{\text{blk}}$ (post-2024 halving: $3.125$ BTC $= 3.125\cdot10^{8}$ sats)
— *plus* the orphan risk of the withheld branch. This is the reviewers' point:
the attacker pays a **fixed cost to re-roll a lottery whose payout is $V$**, so
the attack is viable above a value threshold.

### 4.2 The gain per re-draw, bounded

A re-draw is worth something only if the **new** panel is decisive where the old
one was not. The decisive configurations are those exactly one seat short of the
threshold, so the maximum value of one re-drawn seat is

$$\Delta P \;\le\; \Pr\big[X = t-1\big] \;=\; \binom{N}{t-1}\rho^{\,t-1}(1-\rho)^{\,N-t+1}. \tag{5.9}$$

This is a *generous* upper bound for the attacker (it assumes a single seat
flips the verdict and that the attacker can find a block maximizing the gain),
which is the right direction for a bound used to rule an attack out.

| $N$, $t$ | $\rho = 1/3$ | $\rho = 0.40$ | $\rho = 0.45$ | $\rho = 0.49$ |
|---|---|---|---|---|
| 15, 10 | 2.232·10⁻² | 6.121·10⁻² | 1.048·10⁻¹ | 1.434·10⁻¹ |
| 45, 30 | 1.434·10⁻⁵ | 5.258·10⁻⁴ | 3.978·10⁻³ | 1.404·10⁻² |
| 105, 70 | 9.322·10⁻¹² | 6.106·10⁻⁸ | 9.013·10⁻⁶ | 2.119·10⁻⁴ |

### 4.3 The bound

> **Theorem 5.4 (seed-grinding viability bound).** A block-withholding re-draw
> is EV-positive only if
>
> $$V \;>\; \frac{R_{\text{blk}} + \text{fees}}{\Delta P}
> \;\ge\; \frac{R_{\text{blk}}}{\Pr[X = t-1]}, \tag{5.10}$$
>
> so for every disputed value below the right-hand side the seed is
> **grind-proof by price**, and any residual exposure is confined to disputes
> whose value exceeds the threshold.

$R_{\text{blk}} = 3.125\cdot10^{8}$ sats:

| $N$, $t$ | $\rho=1/3$ | $\rho = 0.40$ | $\rho = 0.45$ | $\rho = 0.49$ |
|---|---|---|---|---|
| 15, 10 | 1.40·10¹⁰ sats (140 BTC) | 5.11·10⁹ (51 BTC) | 2.98·10⁹ (30 BTC) | 2.18·10⁹ (22 BTC) |
| 45, 30 | 2.18·10¹³ sats (2.2·10⁵ BTC) | 5.94·10¹¹ | 7.86·10¹⁰ (786 BTC) | **2.23·10¹⁰ (223 BTC)** |
| 105, 70 | 3.35·10¹⁹ | 5.12·10¹⁵ | 3.47·10¹³ | 1.47·10¹² |

**Reading.** The cheapest grinding scenario in the whole shipped configuration —
an adversary holding **49 % of the selection weight**, on the shipped **round-2**
panel (45 seats), with a favourable one-seat flip — needs a dispute worth
**≥ 223 BTC**. BAO market values are $\lesssim 10^{8}$ sats ($\le 1$ BTC), so the
bound holds with **≥ 220× margin in the most attacker-favourable case**, and the
margin then grows geometrically with panel size and as $\rho$ falls from 0.49
(at $\rho = 1/3$ on 45 seats it is $2.2\cdot10^{13}$ sats, i.e. $2\cdot10^{5}$×
the largest plausible market). That is the honest quantitative form of
`THREAT_MODEL.md` §6 PO-2's claim that "demo/testnet stake sizes make grind cost
unattractive": it is not merely unattractive, it is out of range by two orders
of magnitude *even for a 49 % whale*, which is why §1.4's panel-size guidance
also hardens the seed.

### 4.4 The fix, and why the ordering is the fix

> **Fix 4.1 (freeze-then-seed).** Fix the seed block **height** — not the hash —
> as a function of the moment the *candidate set* is committed:
> $h^{*} = h_{\text{freeze}} + \Delta$ with $\Delta \ge 6$. The dispute-open
> event commits $(\text{candidateRoot}, \text{params root}, h_{\text{freeze}})$;
> $h^{*}$ is then a deterministic function of data that is already immutable,
> so **no party — disputer, host, or miner — chooses the seed height after
> seeing any hash.**

The ordering matters and is worth spelling out, because "multi-block beacon"
alone does not achieve it:

- If the height is chosen *after* candidate freeze but *by the host*, the host
  can pick a height whose hash produces a friendly panel — the fix is void.
  Hence $h^{*}$ must be **derived**, not selected.
- If the seed is drawn from $k \ge 3$ hashes at fixed depths (CRYPTO_AUDIT
  §2.4's S-1 proposal), the **last** block's miner retains exactly the
  one-block option of §4.1 — a $k$-block beacon removes the *earlier* blocks'
  leverage (an adversary must control all $k$, cost $\propto \beta_{\text{mine}}^{-k}$)
  but **not** the tip's. Multi-block beacons reduce the attack's *availability*
  (the adversary must own the tip block: probability $\approx \beta_{\text{mine}}$)
  and its *earlier* leverage; they do not change (5.10).
- Freezing candidates **before** the seed exists is what removes the
  *choice-of-candidates* attack (a coordinator who can add or drop candidates
  while the seed is known re-selects adversarially — `selectionAttempts` +
  `excludedPubkeys` currently only make it *visible*, `THREAT_MODEL.md` §6 PO-2).

### 4.5 Residual (stated, not closed)

1. **The tip-block option is irreducible without a beacon outside Bitcoin.**
   Whoever mines $h^{*}$ can always withhold at cost $R_{\text{blk}}$; (5.10) is
   the price, not a proof of impossibility. A drand/NIST-style external beacon
   removes it and imports a different trust assumption — an operator decision,
   not a protocol improvement.
2. **Availability is $\beta_{\text{mine}}$-scaled.** An adversary that owns a
   fraction $\beta_{\text{mine}}$ of hash power gets the *opportunity* on
   $\approx\beta_{\text{mine}}$ of disputes; (5.10) is per-opportunity. Combined
   expected exposure $\approx \beta_{\text{mine}}\cdot\Pr[V > \text{(5.10)}]$ —
   both factors small at BAO scale.
3. **A large miner's re-draws are correlated with its ordinary income** (the
   withheld block is a block it would otherwise have earned), so the "forfeit"
   is a genuine loss but not a cash outflow. This does not change the ordering
   in (5.10) — it changes the attacker's *liquidity* requirement, not its EV.
4. **`reputationRoot` remains uncommitted** (PO-2/F-5/PO-7): two honest verifiers
   with different pool snapshots still disagree. That is an orthogonal gap and
   is *not* fixed by freeze-then-seed; it needs the S-1 protocol event.

## 5. The √stake splitting result (Claude #3)

### 5.1 The rule under scrutiny

`quadraticPriority(random, stake) = -ln(r)/√stake` (`selection.ts:204–209`),
whose exponential-race property is stated and proved in paper §4.2:
with $r_j$ uniform on $(0,1)$, $\pi_j = -\ln r_j/\sqrt{w_j} \sim
\operatorname{Exp}(\sqrt{w_j})$, and the minimum over the pool is won by $j$
with probability $\sqrt{w_j}/\sum_k \sqrt{w_k}$; the race repeats memorylessly
for each subsequent rank, so the top-$N$ order statistics sample **without
replacement at rates** $\sqrt{w_j}$ (`selection.ts:221–229`,
`weightedPriority`).

### 5.2 The splitting theorem

> **Lemma 5.5 (√k splitting gain).** Let an adversary hold total stake $w$ and
> split it into $k$ identities of equal stake $w/k$, each eligible. Its
> selection weight is (a) $\sqrt{w}$ unsplit and (b) $\sqrt{kw}$ split, since
> the exponential rates add across identities controlled by a single principal:
>
> $$\sum_{i=1}^{k}\sqrt{\frac{w}{k}} \;=\; k\sqrt{\frac{w}{k}} \;=\; \sqrt{k}\sqrt{w}
> \;=\; \sqrt{k}\cdot w^{1/2}. \tag{5.11}$$
>
> Hence **the weight gain is exactly $\sqrt{k}$**, and because selection
> probability is proportional to aggregate rate, so is the expected seat count
> (subject only to the $k \le N$ cap on how many seats the identities can hold).

*Proof.* The exponential race has rate $\sqrt{w_i}$ per identity; rates add for
a single principal maximizing a linear objective, and $\sum_i \sqrt{w/k} =
\sqrt{k}\sqrt{w}$ by direct algebra. The RHS is strictly increasing in $k$ for
$w > 0$, so splitting strictly dominates for $k > 1$. ∎

Numerically: $w = 1{,}000{,}000$ sats → weight $\sqrt{w} = 1{,}000$; split into
$k = 4$ → $\sqrt{4\cdot 10^6} = 2{,}000$ (**2×** for the same capital); $k = 100$
→ $10{,}000$ (**10×**).

### 5.3 The ceiling is the eligibility gate — and the ceiling is the problem

Splitting is bounded by the **1 %-of-volume eligibility gate**
(`selection.ts:275`: `stakeCapacitySats >= marketVolumeSats * 0.01`), so

$$k \;\le\; k_{\max} \;=\; \Big\lfloor \frac{w}{0.01\,V_m} \Big\rfloor,
\qquad\text{hence}\qquad
\text{weight}(w) \;\le\; \sqrt{k_{\max} w} \;=\; \frac{w}{\sqrt{0.01 V_m}}. \tag{5.12}$$

| $w$ (sats) | $V_m$ (sats) | $k_{\max}$ | weight gain $\sqrt{k_{\max}}$ | weight |
|---|---|---|---|---|
| 1,000,000 | 1,000,000 | 100 | **10×** | 1,000 → 10,000 |
| 10,000,000 | 1,000,000 | 1,000 | **31.6×** | 3,162 → 100,000 |
| 1,000,000 | 100,000,000 | 1 | 1× (gate binds) | 1,000 → 1,000 |

> **Lemma 5.6 (saturation to linearity).** At the ceiling (5.12) the weight is
> $w/\sqrt{0.01V_m}$ — **linear in stake**, not concave. For a fixed market,
> a 4× larger stake yields a 4× larger weight once both adversaries split to
> their ceilings: $w = 10^6 \to 10^4$ weight, $w = 4\cdot10^6 \to 4\cdot10^4$,
> $w = 1.6\cdot10^7 \to 1.6\cdot10^5$.

**So the quadratic lottery is anti-plutocratic only while identities are
indivisible** — and the 1 % gate makes identity *highly* divisible precisely for
large holders: a stake $w > 0.01\,V_m$ can be cut into $k_{\max} = w/(0.01V_m)$
gate-passing identities, while a stake $w \le 0.01\,V_m$ cannot be cut at all
(it is already at the floor, and cutting it would exclude every piece). So the
concavity is an artefact of the identity partition above the gate, and the
equilibrium weight is linear in stake. The paper's own sentence — "a juror with
4× stake is only 2× as likely to serve" (paper §4.2) — is **true of a single
identity and false of a capital holder**, who posts 4 identities of 1× stake and
is 4× as likely to serve (until $k_{\max}$ bites; and $k_{\max}$ grows linearly
with $w$, so it never bites for the largest holder).

### 5.4 The real Sybil defence is admission, not the exponent

The two mechanisms that actually bound $k$ are the ones the reviewers should be
pointed at:

- **`filterEligibleJurors`** (`selection.ts:263–286`): WoT score floor, minimum
  account age (fail-closed on future registration timestamps), market-category
  match, confirmed stake commitment, and the 1 % gate. Each *additional*
  identity costs a WoT-80-scoring, age-qualified, vouched-for identity — a
  **non-monetary, non-purchasable** cost, which is exactly what (5.12) cannot
  price.
- **Phase-0 zero-stake mode has no √ term at all**: `weightFn` mode uses
  `weightedPriority(random, weight)` — probability $\propto w$ directly
  (`selection.ts:221–229`) — so splitting gains $k\times$, not $\sqrt{k}$, in
  the *weighting*; the bound there comes entirely from the reputation weight's
  own caps ($w \le 3.81\,w_0$ per identity, Lemma 1.3 of `01-farming`) and from
  eligibility. Stated plainly: **phase-0 is the mode where the splittable
  quantity is the weighting itself**, and its defence is the identity filter.

### 5.5 The corrected claim (what this PR changes in the paper)

`docs/FROST_COURT_ORACLE_PAPER.md` §4.2's anti-plutocracy paragraph is rewritten
to state the theorem instead of the intuition:

> Quadratic weighting makes a **single identity's** selection probability
> concave in its stake ($4\times$ stake $\to 2\times$ probability), which prices
> *concentrated* capital. It does **not** bound a capital holder that partitions
> itself: by Lemma 5.5 the weight gain is exactly $\sqrt{k}$ for $k$ identities,
> and by Lemma 5.6 the achievable weight saturates at $w/\sqrt{0.01V_m}$ — i.e.
> **linear in stake** once splitting reaches the eligibility ceiling. The Sybil
> price is therefore carried by the admission filters (§4.3: WoT, account age,
> confirmed commitments), not by the exponent; the lottery's concavity is a
> *transaction-cost* on splitting (each split identity must clear the gates), and
> its value is exactly the gate cost per identity.

This is a weaker claim than the paper made, and it is the one the algebra
supports.

## 6. Consolidated result table

| # | Reviewer | Result | Figure |
|---|---|---|---|
| 1 | Claude #5 | Capture probability, binomial, exact | 0.8504 % (N=15, ⅓) and 5.001·10⁻⁶ (N=45, ⅓) — **both reviewer figures confirmed**; new findings at the 3-of-5 round-0 quorum (0.2099 / 0.4813) and the `confirmQuorum` code default of 1 (0.8683 / 0.9655) |
| 2 | Claude #4 + Gemini A | $V_{\max}$ per rail; (C-i) holds only on staked rails | Staked: 369k (N=15) → 1.425M (N=45) → 29.9M (N=135) → **unbounded at $t \ge 100$**. Lightning: $\alpha = 0$, $V_{\max}$ = stream only, **no capital bound** |
| 2 | Gemini A | Market-cap invariant $V_{\max} \le \gamma\sum_i S_i$ | $\gamma = \alpha p_{\text{flip}} = 0.5$; **fails at N=45 (0.45V)**, holds at N=135 (1.35V); guardian check = $2M$ sats bonded per $1M$-sat dispute |
| 3 | Claude #4 + Gemini A | P+ε cost | $\max(0,1-2\pi)X$ per juror — **free at $\pi \ge \tfrac12$** (reviewer's "ε" is the $\pi \to 1$ limit), full price at $\pi = 0$; resistance requires an act-contingent forfeit, $tD \ge V - \kappa_0m$ (Theorem 5.2) |
| 3 | (both) | Pure-pay rails | **Confirmed and proved** (Corollary 5.3): $X = P/\lvert C\rvert$ bounded by the closed fee budget, so P+ε wins at $\varepsilon = 0$ |
| 4 | Claude #2 | Seed-grinding bound | $V > R_{\text{blk}}/\Pr[X = t-1]$: cheapest case **2.23·10¹⁰ sats (223 BTC)** at N=45, $\rho=0.49$ — **≥ 220×** above any BAO market; fix = **derived** seed height from the freeze height |
| 5 | Claude #3 | √stake splitting | $\sqrt{k}$ proven (5.11); ceiling $k_{\max} = w/(0.01V_m)$ (5.12); **saturates to linear in stake** (Lemma 5.6) — paper §4.2 corrected |

## 7. What is NOT proved here (this round's ledger)

- **GAP-5a (Model D independence).** §1's numbers are binomial; the shipped draw
  is without replacement (hypergeometric, thinner-tailed at the same mean). We
  use the binomial deliberately — it is the attacker-favourable direction — but
  we have not proved a finite-pool bound, and at the spec's active set
  $A \approx 50$ with $N = 15$ the finite-pool correction is not negligible.
- **GAP-5b ($\rho$ is not observable).** Nothing in §1 tells an operator what
  $\rho$ is; weight concentration is computable from the published weights, but
  *colludability* is not, and the two are what compose. The capture table is a
  parameterized threat surface, not a measurement.
- **GAP-5c (the stream term's value).** Every $V_{\max}$ in §2 inherits
  $L_{\text{stream}} = J/(1-\delta)$ from A1/A7, with $J \approx 3{,}500$
  sats/epoch and $p_{\text{eject}} = 0.5$ — both deployment measurements, and in
  the Lightning rail's case both are contested outright (§2.4). Replacing
  $L_{\text{stream}}$ moves every table row proportionally; the *structure*
  (denominator, crossover, invariant) does not move.
- **GAP-5d (P+ε credibility).** (5.7) prices an unsecured promise: the refund
  is owed exactly when the briber has lost, by a party that must then perform.
  If the contract must be escrowed to be credible, the escrow is observable and
  the coordination cost $\kappa_0$ (A3) is no longer a fixed constant — the
  model treats $\kappa_0$ as given and does not price the observability
  trade-off. This is where the empirical measurement (README §4's Monte Carlo,
  `colluder` strategy) should go next.
- **GAP-5e (Theorem 5.2's $D$ is not implementable yet).** No shipped artefact
  is an act-contingent forfeit: the escrow's slash is outcome-contingent
  (`escrow.ts:93–96`) and the clawback flags are reputation-only (paper §6.3).
  (5.8) is a design condition, not a description of the deployed mechanism.
- **GAP-5f (Lemma 5.6 assumes the split is free).** Each split identity pays the
  admission cost (WoT, age, commitment); §5.4 asserts that this is the binding
  term but does not measure it. The measurement is the pool's identity-cost
  distribution — a deployment datum, deliberately not invented here.

## 8. Reproduction

```bash
node scripts/review-quant/economics.mjs   # every number in §1–§5
```

Deterministic, dependency-free, exact rational arithmetic (BigInt) for every
probability; the IEEE double paths are used only for the money tables, where
they are printed as integers after rounding and are stable to the sat at these
magnitudes.
