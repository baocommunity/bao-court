# The Expert Re-Verify — five economic attacks on the post-fix incentive layer

**Round 30 (2 of 2), expert-verifier pass.** The two prior rounds asked whether
each fix answered its reviewer (`REVIEW_ROUND_2.md`) and what each fix itself
opened (`REVIEW_ROUND_3.md`). This round asks the *economic* version of the
second question, on the layer as it now ships: **does the incentive structure
still hold its inequality after the fixes, and where did a fix move an attack
rather than remove it?**

**Base:** `origin/main` @ `bb52800` (`v0.12.1`) plus the host-side R30 changes
(`bao.markets` `7e71dd197`: exposure re-assessment + per-market ladder freeze).
**Branch:** `docs/econ-verify`. **Premises:** the game of
[`00-model.tex.md`](00-model.tex.md) (players, A1–A9, closed-budget lemma L-0),
unchanged. Where an attack needed a model change it is stated in that attack's
§*model change* and added to this file's own ledger (§8), never silently
absorbed into `00-model`.

**Method.** Each attack is stated as an adversary's optimisation problem with
the shipped parameter values read from code (`file:line` below), solved for its
extremum, and then *decided*: either **SAFE**, with the inequality that makes it
so, or **EXPLOITABLE**, with the bound that says how much. A premise that does
not survive the algebra is reported as false — an audit brief is a hypothesis,
not a finding.

**Verdict summary.**

| # | Attack | Verdict | The number |
|---|---|---|---|
| r30-1 | the escalation bond is an unbounded **option** (one bond, every round) | **EXPLOITABLE** — priced option not enforced (farming sign stays safe at $a_f = 0.9$) | farming EV improves from −2.40 % to −1.86 % of $V$ at the shipped cap (−0.543 % at the protocol cap); venue/griefer cost ratio **0.86× at $R{=}2$ but 54.1× at $R{=}5$** |
| r30-2 | the frozen ladder vs a **shrinking cohort** | **EXPLOITABLE at host** | 135 → 45 seats: capacity $0.405V$ vs $1.215V$ = **2.47× short**; the honest cap falls from *unbounded* to **101,250 sats** |
| r30-3 | the $\lceil 2N/3\rceil$ default vs an explicit **3-of-5** in the cap | **SAFE** (the brief's premise is false) | $\kappa_q = 2.75$–$4.64$ is **slack in the cap's favour**, not exposure; the cap binds at $\rho = 0.5325$ (4-of-5) vs $\rho = 0.3471$ (3-of-5) |
| r30-4 | **decaying commitment** vs the retainer | **EXPLOITABLE** — the fix raised the loop's value | ramp average **0.6298 vs 0.5000** (6/6), **0.7225 vs 0.5000** (1/6), dominating the cliff at every finite cycle; retainer optimum unchanged at $p^{*} = \max(0, 2\tau-1)$ |
| r30-5 | **shadow-mode** asymmetry | **SAFE** on the label, **EXPLOITABLE-lite** on grandfathering | no secret: every input is public; the grandfathering bound is exactly r30-2's 2.47×, and the frozen 135-seat config is scale-free ($\gamma\sigma N = 1.215$) |

One fix is shipped here (r30-3's arithmetic, as `quorumEconomics.ts`: **+2 files,
additive export, no behaviour change**); four are registered with their exact
shape (§7). No protocol parameter changes: $\gamma = 0.45$, $\lambda = \ln 2/3$,
$\sigma = 2\,\%$, $s_0 = 5{,}000$, `maxLadderRounds` = 2, the $\lceil 2N/3\rceil$
default and the retainer threshold $\tau$ all keep their shipped values. What
changes is the **rule** attached to three of them.

---

## 0. The layer under attack — what is actually shipped now

| Surface | Shipped state | Binding |
|---|---|---|
| confirm quorum | default $\lceil 2N/3\rceil$; an explicit weaker quorum is accepted and recorded | `courtConfirmationMachine.ts:257` (`params.confirmQuorum ?? confirmSupermajority(...)`), `:270` (`quorumBelowSupermajority`); `confirmationMachineCore.ts:52–54` |
| escalation authority | witness-bound to **this** challenger's accepted bond (`idx` + hash); the log is re-verified at finalize | `confirmationMachineHandlers.ts:543–556` (r29-1), `confirmationMachineCore.ts:313–413` (r29-2) |
| ladder depth | frozen **in state** at creation, default 2, bounded 1..5 | `courtConfirmationMachine.ts:280–287`, `confirmationMachineTypes.ts:205` |
| round panel | host-supplied per round, bounded only by $[3, \text{MAX}]$ | `confirmationMachineHandlers.ts:262–263`, `confirmationMachineCore.ts:121–134` |
| economic cap | $\gamma = 0.45$ fail-closed, derived per ladder config, re-assessed against **server-side** exposure, ladder **frozen per market** | host `packages/markets/services/bao-markets/courtEconomicRatio.ts` (`DEFAULT_COURT_ECON_GAMMA`, `deriveCourtEconomicCap`, `resolveCourtMarketExposureSats`, `resolveCourtLadderFreeze`) |
| bond schedule | $\max(0.05 V_m, 10{,}000)\cdot 2^{r-1}$ per round at the **helper**; the machine charges it once (§1) | `escrow.ts:117–129` (`calculateBondAmount`); `confirmationMachineHandlers.ts:546–552` |
| retainer metric | $S = a_r(\tfrac12 + \tfrac12 p_r)$, FLOOR 0.5, window-local | host `courtSlaComposite.ts:24,59` |
| reputation weight | $w_0\cdot g\cdot\Pi\text{pen}\cdot(1+\lambda\sum c_e 0.9^{\text{age}})$, floored at $0.5w_0$, **then** continuous idle decay $w = w_0 + (\text{earned}-w_0)e^{-\lambda\,\text{idle}}$, $\lambda = \ln 2/3$ | host `jurorReputationWeight.ts` (`decayLambda`, `computeJurorWeight` step 5) |
| ladder price | $\Delta C_{r+1} = 3^{r+1}b_0$ cumulative $4/13/40/121/364\times$ | **spec-pinned** (05 §5.3) — see r30-1 |

The last row is the hinge of the first attack: **the price curve is
spec-pinned, the bond that pays it is code-pinned, and the two no longer
describe the same mechanism.**

---

## 1. r30-1 — the escalation bond is an option, and the option is free

### 1.1 Model change

Theorem 2 (`02-ladder.tex.md`) prices escalation with a strictly increasing
marginal cost,
$$\Delta C_{r+1} = 3^{\,r+1} b_0 \qquad\Longrightarrow\qquad c_1..c_5 = 4,13,40,121,364\times b_0 .$$

The shipped machine does not charge it. `onEscalate` accepts any bond that
appears in **this challenger's** accepted challenges:

```ts
// confirmationMachineHandlers.ts:546-552 (r29-1 binding — correct, and orthogonal)
state.challenges.some((c) => c.idx === idx && c.bondProofHash === event.bondProofHash)
```

That is a **membership** test, not a **consumption** test. No event in the
machine carries a per-round bond amount, `accept_challenge` is the only event
that admits a bond, and the escalation event carries no amount at all. The host
agrees: `CourtEscalationService.EscalationRequest.bondTxid` is documented as
"the case's challenge bond" — one per case, reused (r29-3, registered as LOW
"bounded at 5 rounds"). So the shipped marginal cost is

$$\boxed{\;\Delta C_{r+1}^{\text{shipped}} = 0 \quad\text{for every } r\;}$$

and the whole ladder is bought with one payment. The model change is confined
to one symbol: $\Delta C_{r+1} \to 0$. Everything else ($a_f$, $\rho$, $\beta$,
the Bayesian update, the closed budget) is unchanged.

### 1.2 The EV of the option

A challenger that has lost round 0 decides at each rung: concede (keep the
rejection, bond forfeits) or escalate (bond already posted, so no new cash
leaves). Let $R$ = the deepest round it escalates to, $\rho V$ = the reward on
a win, $\beta V$ = the bond:

$$\mathbb{E}[\pi(R)] = (1-a_f^{R})\,\rho V \;-\; a_f^{R}\,\beta V ,
\qquad \mathbb{E}[\pi(0)] = -\beta V .$$

The difference is the option's value:

$$\boxed{\;\mathbb{E}[\pi(R)] - \mathbb{E}[\pi(0)] = (1-a_f^{R})(\rho+\beta)V \;>\; 0
\quad\text{for every } R \ge 1.\;}$$

**Escalation to the cap weakly dominates conceding for every challenger with
$a_f < 1$.** Theorem 2's stopping rule $r^{*}$ is not merely loose — it is
inoperative: the rational $r$ is the *policy* cap, because the marginal cost that
made the ladder a stopping device has gone to zero. At the shipped parameters
($a_f = 0.9$, $\rho = 0.03$, $\beta = 0.03$, `maxLadderRounds` = 2):

| escalated to $R$ | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| $\mathbb{E}[\pi]$, spec bond $\beta = 3\,\%$ | −3.000 % | −2.400 % | **−1.860 %** | −1.374 % | −0.937 % | −0.543 % |
| $\mathbb{E}[\pi]$, escrow bond $\beta = 5\,\%$ | −5.000 % | −4.200 % | **−3.480 %** | −2.832 % | −2.249 % | −1.724 % |

At the **shipped** cap the unmerited challenger's burn falls from Theorem 1's
−2.40 % of $V$ to −1.86 %: **22.5 % of the deterrent gone**, at zero revenue to
the mechanism. At the protocol cap ($R = 5$) it is **−0.543 %, a 77.4 %
erosion**. The mechanism gave away, at $R = 5$, an option worth
$\sum_{r=1}^{5} 3^{r}b_0 = 363\times$ the bond it charged.

### 1.3 The farming sign: SAFE, with the inequality

The erosion changes a constant, not a sign:

$$\mathbb{E}[\pi(R)] < 0 \iff a_f^{R} > \frac{\rho}{\rho+\beta}
\iff R < \frac{\ln\!\big(\rho/(\rho+\beta)\big)}{\ln a_f}.$$

| bond | $\rho/(\rho+\beta)$ | flip round | protocol cap | verdict |
|---|---|---|---|---|
| spec $\beta = 3\,\%$ | $1/2$ | $R \ge 6.58 \Rightarrow 7$ | 5 | **SAFE** — 2 rounds of margin |
| escrow $\beta = 5\,\%$ | $0.375$ | $R \ge 9.31 \Rightarrow 10$ | 5 | **SAFE** — 5 rounds of margin |

This is the honest half of the answer: **the one-bond option cannot make
challenge-farming profitable at the shipped accuracy**, because the bond/reward
symmetry of Lemma 1.2 means the win probability must exceed one half *within the
capped ladder*, and the capped ladder is $\le 5$ rounds. It can, and does, make
griefing cheaper — which is the other half.

The margin is thinner than it looks, and it is governed by one measured
quantity. $a_f$ is A4, not a constant:

| $a_f$ (jury accuracy on manufactured disputes) | flip round $\lceil\ln(\rho/(\rho+\beta))/\ln a_f\rceil$ | $\mathbb{E}[\pi]$ at $R{=}2$ (shipped cap) | at $R{=}3$ | at $R{=}5$ (protocol cap) |
|---|---|---|---|---|
| **0.90** (A4) | 7 | −1.860 % | −1.374 % | −0.543 % |
| 0.85 | 5 | −1.335 % | −0.685 % | **+0.338 %** |
| 0.80 | 4 | −0.840 % | −0.072 % | **+1.034 %** |
| 0.75 | 3 | −0.375 % | **+0.469 %** | +1.576 % |
| 0.70 | 2 | **+0.060 %** | +0.942 % | +1.992 % |

**A five-point drop in measured accuracy (0.90 → 0.85) makes the *protocol* cap
profitable; a twenty-point drop makes the *shipped* cap profitable.** The
option's sign-safety therefore rests entirely on $a_f$ — a *measured* quantity,
which is why the durable fix in §1.5 is a rule on the ladder cap rather than a
constant.

### 1.4 The witness as a griefing vector — what a round costs the venue

The reviewer's second question is the one with teeth: a *valid* witness forces
a round, so what does a round cost the challenger versus the venue?

- **Challenger, marginal:** $0$ sats (§1.1). If it wins, the bond returns.
- **Challenger, terminal:** $\beta V$ — already sunk at round 0, identical at
  $R = 1$ and $R = 5$. Escalating is therefore free at the margin *and*
  free in the tail.
- **Venue:** round $r$ summons $n_r = 5\cdot 3^{r}$ seats. The panel is owed the
  spec's 25-sat-per-juror floor; that mass is funded from the loser's bond up to
  $\ell = 0.02V$ **per case** (not per round), and the operator's own fan-out,
  ack-processing and retention work costs $c_s$ per summon. Nothing funds either
  beyond that budget:

$$K(R) \;=\; \sum_{r\le R} n_r\,c_s \;+\; \max\Big(0,\ \sum_{r\le R} 25\,n_r - \ell\Big).$$

At $V = 1{,}000{,}000$ ($\ell = 20{,}000$, escrow bond $50{,}000$), compared with
what the same griefer loses at the same depth:

| $c_s$ | $R{=}1$ | $R{=}2$ (shipped) | $R{=}3$ | $R{=}4$ | $R{=}5$ (protocol) |
|---|---|---|---|---|---|
| 250 | 0.09× | **0.43×** | 1.72× | 6.67× | 27.8× |
| 500 | 0.18× | **0.86×** | 3.44× | 13.3× | **54.1×** |
| 1,000 | 0.36× | 1.72× | 6.89× | 26.7× | 106.8× |

($\text{venue cost} \div \text{griefer's loss}$; the griefer's loss is
$0.042V$ at $R{=}1$ falling to $0.0172V$ at $R{=}5$ because escalation buys it
win probability.)

> **Finding 1.1 (the option is correctly priced at the shipped depth and
> diverges by $3^{r}$ after it).** At $R \le 2$ the venue's cost stays **below**
> the griefer's loss (0.43–0.86× at $c_s = 500$): the shipped cap is, almost
> accidentally, close to a fair price — which is the second, independent reason
> the shipped parameter set is safe. From $R = 3$ the ratio tracks $3^{r}$:
> **3.4× at round 3, 13.3× at round 4, 54.1× at round 5**, and the panel's
> 25-sat floor alone becomes unfunded at depth (45,375 sats of fee mass over the
> ladder against a 20,000-sat case budget — a **25,375-sat hole** the venue
> fills). The defect is not that griefing is free; it is that it **stops getting
> more expensive for the griefer exactly where it starts getting expensive for
> the operator.**

Two honest qualifiers, both of which cut against over-claiming:

1. **Forcing rounds does not help a cartel.** A capture must survive *every*
   contested round ($\pi = \prod_r \pi_r$, 05 §3.3), so an extra round is
   another chance for the honest side to overturn. The griefing vector is a
   pure **cost transfer**, not a capture amplifier — the opposite of the naive
   reading, and the reason the fix must be *price*, not *prohibition*.
2. **The cohort is compensated; the venue is not.** The forfeited bond enters
   the pool as `bond_forfeit` (Corollary 2.1), so the panel that does the
   forced work is paid from it until the fee floor binds. The unfunded party is
   the operator — which is why this is a **venue** finding, and why the right
   fix is a *price the operator can keep*, not a bond increase the cohort
   receives.

### 1.5 Fix

**Registered, wire (`v0.13`, cannot be shipped here).** Bind a bond to a
*round*, and consume it:

- `accept_challenge` gains `round` (1-based ladder round the bond is posted
  for); the challenge record stores it;
- `escalate`'s witness gains `bondRound`, and its predicate becomes
  "a bond witnessed for **exactly** `round = ladderRound + 1`, by this
  challenger, not already consumed by an earlier escalation record";
- `assertValidEscalationLog` gains the matching monotonicity check (rounds
  strictly increasing per bond, no bond reused across rounds).

> **Landed in v0.13.0 (R31).** Shipped as `escalate.roundBondProofHash` +
> `CourtEscalationRecord.roundBondProofHash` + the frozen `requireRoundBond`
> policy instead of a challenge-side `round`: the hash is bound to its round by
> the existing `roundIndex === ladderRound + 1` guard and by the append-only
> log, which keeps the change additive for v0.12 consumers
> (`requireRoundBond` defaults to `false`). The reducer refuses a missing
> per-round witness on a strict case, a relabelled membership bond, and a
> consumed hash; `assertValidEscalationLog` re-derives the same three rules.
> Matrix: `docs/PER_ROUND_BOND.md`. The boxed cap rule below is exported as
> `deriveMaxLadderRounds` (the safe cap — the largest depth with `E[π] < 0`
> strictly, **break-even excluded**, evaluated as the exact integer inequality
> `R·D^d < A^d·(R+B)` since R52, clamped to the machine ceiling) with its
> companion `deriveLadderFlipRound` (the first round that is not strictly
> unprofitable — this section's 7/5/4/3/2 column, always exactly one above the
> unclamped cap), and the schedule as `escalationBondMultiple` /
> `cumulativeLadderBondMultiple`.

**Registered, host (small, and the helper already exists).** The per-round
amount must be `calculateBondAmount(volume, round)` = $\max(0.05V_m,
10{,}000)\cdot 2^{r-1}$ (`escrow.ts:117–129`) — note that the **code doubles**
($2^{r-1}$) while the **spec triples** ($3^{r}$): for $r=2$ that is $2\times$ vs
$9\times$, a 4.5× gap at the very rung the shipped cap reaches. Reconcile the
two before wiring the per-round bond, or the ladder stays under-priced by
$2^{r-1}/3^{r}$.

**Interim parameter rule (shipped today, no code change).** The ladder cap must
be chosen from the *measured* accuracy, not the other way round:

$$\boxed{\;\texttt{maxLadderRounds} \;\le\; \left\lfloor \frac{\ln\!\big(\rho/(\rho+\beta)\big)}{\ln a_f} \right\rfloor \;}$$

At A4's $a_f = 0.9$ this admits 6, so the shipped 2 and the protocol 5 both
pass and no operator has to give up appeal depth today. It becomes a real
constraint the moment accuracy is measured lower — 0.85 clamps the cap to 4,
0.80 to 3, 0.75 to 2, 0.70 to 1 — which is exactly the pre-flight gate the
mechanism needs: **re-measure $a_f$, re-derive the cap.** This is a parameter
rule, not a proof: it prices the option without changing the machine.

---

## 2. r30-2 — the frozen ladder and the cohort that shrinks

### 2.1 Model change

The cap is derived from the **configured** panel $N_{\text{cfg}} = 5\cdot 3^{R}$
and the invariant is

$$V \;\le\; \gamma \sum_i S_i \;=\; \gamma\, n_{\text{act}} \max(\sigma V, s_0)
\qquad\text{with } n_{\text{act}} = \text{the panel actually seated.}$$

The cap's derivation (05 §2) assumes $n_{\text{act}} = N_{\text{cfg}}$. The R30
freeze pins $N_{\text{cfg}}$ on the market row — correctly, it closes r29-8's
TOCTOU — but nothing pins $n_{\text{act}}$. Two machine facts make the gap real
rather than hypothetical:

1. the round roster is **host-supplied per round** and validated only into
   $[3, \text{MAX}]$ (`confirmationMachineHandlers.ts:262–263`,
   `confirmationMachineCore.ts:121–134`) — a round-2 "45-seat" panel may legally
   be 3 seats;
2. the *eligible* cohort can shrink below $N_{\text{cfg}}$ through churn
   (retention monitors eject at $O_j > 50\,\%$, spec L253; 2 consecutive
   SLA-miss epochs eject, spec L191), and `filterEligibleJurors`
   (`selection.ts:263–286`) then returns fewer than $n_r$ candidates.

So the model change is one symbol: $n_{\text{act}} \le N_{\text{cfg}}$, unknown
at creation. The cap must hold at $n_{\text{act}}$, not at $N_{\text{cfg}}$.

### 2.2 The EV computation — how many seats does a value need?

Setting $V = \gamma\, n\,s(V)$ and solving for $n$ gives the **minimum
adjudicating panel**:

$$N_{\min}(V) \;=\;
\begin{cases}
\Big\lceil \dfrac{V}{\gamma s_0} \Big\rceil = \Big\lceil \dfrac{V}{2{,}250}\Big\rceil, & V \le V_{\text{knee}} = \dfrac{s_0}{\sigma} = 250{,}000,\\[3mm]
\Big\lceil \dfrac{1}{\gamma\sigma}\Big\rceil = 112, & V > 250{,}000 \ \text{(proportional regime)}.
\end{cases}$$

| $V$ (sats) | 50,000 | 100,000 | 250,000 | 500,000 | 1,000,000 | 10,000,000 |
|---|---|---|---|---|---|---|
| $N_{\min}$ | 23 | 45 | 112 | 112 | 112 | 112 |

The frozen-config capacity is $\gamma\sigma N_{\text{cfg}} V$ in the proportional
regime — a *ratio*, not a value:

| $N_{\text{cfg}}$ | 45 | 112 | 135 | 405 |
|---|---|---|---|---|
| $\gamma\sigma N$ | **0.405** | 1.008 | **1.215** | 3.645 |
| verdict at that panel | **invariant fails** | first holding rung | holds | holds, 4× margin |

**The churn arithmetic.** A market created under a 135-seat freeze has
$\gamma\sigma N = 1.215$ and an *unbounded* cap. Let the cohort churn to 45
eligible seats:

$$\frac{\text{capacity}(45)}{\text{capacity}(135)} = \frac{0.405V}{1.215V} = \frac{1}{3},
\qquad\text{shortfall} = \frac{1}{0.405} = \mathbf{2.47\times}.$$

Concretely, on a 1,000,000-sat market: capacity falls from 1,215,000 to
**405,000 sats**, a 2.47× breach; and in the *absolute* terms the operator's own
runbook uses, the honest cap for that market falls from "unbounded" to
**101,250 sats** ($\gamma s_0 N$ at 45) — the market is **9.88×** over the cap
its cohort can actually honour.

### 2.3 Verdict

> **EXPLOITABLE at host (r30-2), bounded at 2.47×.** The freeze makes the
> *configured* ladder immutable but leaves the *seated* panel free, so a market
> priced under a 135-seat cohort can be adjudicated by a 45-seat one. Nothing in
> either repository compares $n_{\text{act}}$ with $N_{\min}(V)$. The exposure
> is bounded (the invariant is a ratio: a 3× seat ratio, a 2.47× capacity
> shortfall at the 45-seat rung, not an unbounded loss) and it requires cohort
> churn or a host error — it is not attacker-triggered. It is nevertheless the
> compound case that makes r30-5's grandfathering dangerous: neither the freeze
> nor the shadow flip is a problem alone.

### 2.4 Fix

**Registered, host (small).** Two checks, both using numbers the shipped module
already returns:

1. **At escalation**, resolve the *current* eligible cohort $N_{\text{el}}$
   (the same `filterEligibleJurors` set the draw uses) and refuse the escalation
   unless $N_{\text{el}} \ge N_{\min}(V)$ for the market's frozen config; settle
   at the deepest rung the cohort can fill instead of opening one it cannot.
2. **At creation and at every deposit**, replace the frozen cap with
   $\min\big(\text{cap}(N_{\text{cfg}}), \text{cap}(N_{\text{el}})\big)$ —
   one extra argument to `deriveCourtEconomicCap`, no new arithmetic.

**Registered, machine (v0.13, not shipped).** `open_ladder_round` should require
`roundRoster.length ≥ round0Roster.length · 3^{round}`. It is a two-line check
and it is *not* shipped here because the event's documented default is
`state.participantIndices` (the round-0 roster), so enforcing the growth rule
would refuse every host that omits `roundRoster` — a liveness change, not a
guard. Register it with the event-shape work it needs.

---

## 3. r30-3 — the quorum the cap never reads (the premise is false)

### 3.1 The question, stated exactly

A market created with an explicit 3-of-5 quorum records
`quorumBelowSupermajority: true` (`courtConfirmationMachine.ts:270`). The
economic cap takes $\{V, \text{rail}, \text{cohort}, \gamma\}$ and **no quorum**
(`assessCourtEconomicRatio`), and $\gamma = \alpha p_{\text{flip}}$ with no
threshold term. So does a 3-of-5 market make the cap optimistic? The brief says
yes, and proposes a correction factor. It does not — and the reason is worth
writing down, because it is a defect in the cap's *contract*, not in its
arithmetic.

### 3.2 Model change: make $\pi$ explicit

The cap of 05 (5.2) charges the attacker the bribe price and credits it the
prize **unweighted**:

$$V < t\,b(V) + \kappa_0 m, \qquad b(V) = p_{\text{flip}}\big(\alpha s + \delta p_{\text{eject}}L\big).$$

But $\pi$ (the probability the captured verdict *survives* every honest
escalation) and $p_{\text{flip}}$ are the **two sides of one coin**:
$p_{\text{flip}} = 1-\pi$. With $\pi$ explicit, the attacker's problem is

$$\pi V \;=\; t\,(1-\pi)\big(\alpha\sigma V + \delta p_{\text{eject}}L\big) + \kappa_0 m$$

$$\boxed{\;V_{\max}(\pi) \;=\; \frac{t\,(1-\pi)\,\delta p_{\text{eject}}L \;+\; \kappa_0 m}{\pi \;-\; t\,(1-\pi)\,\alpha\sigma},
\qquad\text{finite iff } \pi > t(1-\pi)\alpha\sigma.\;}\tag{6.1}$$

**And the shipped number is exactly the $\pi = \tfrac12$ slice.** Verification:
at $t = 30$, $\alpha\sigma = 0.01$, $\delta p_{\text{eject}}L = 33{,}250$, (6.1)
gives $\frac{30\cdot\frac12\cdot 33{,}250}{\frac12(1-0.30)} = \frac{t\cdot
33{,}250}{1-t\alpha\sigma} = 1{,}425{,}000$ — 05 §2.2's table value to the sat,
for *any* $t$. The published cap is the coin-flip normalisation of (6.1).

### 3.3 The $\pi$-family, and which way the correction runs

| $\pi$ | 0.05 | 0.235 | 0.25 | 0.30 | **0.50** | 0.70 | 0.90 | 0.99 |
|---|---|---|---|---|---|---|---|---|
| $V_{\max}$ (sats, $t{=}30$) | unbounded | 138,743,182 | 29,925,000 | 7,758,333 | **1,425,000** | 490,574 | 114,655 | 10,106 |

$V_{\max}$ is **strictly decreasing in $\pi$**: the more likely the captured
verdict is to survive, the *smaller* the admissible value, because a surviving
capture is a capture the attacker did not have to pay the flip premium for. So a
**weaker quorum — which raises $\pi$ — makes the cap TIGHTER, not looser.** The
correction factor the brief asked for exists, and it points the other way:

$$\kappa_q = \frac{\pi(N, q, \rho)}{\pi(N, \lceil 2N/3\rceil, \rho)}
\qquad\text{(exact binomial, shipped panels)}$$

| $\rho$ | $\pi$ at 3-of-5 | $\pi$ at 4-of-5 | $\kappa_q$ | $101{,}250 / \kappa_q$ |
|---|---|---|---|---|
| ⅓ | 0.209877 = **51/243** | 0.045267 = **11/243** | **4.6364** (= 51/11 exactly) | 21,838 |
| 0.40 | 0.317440 | 0.087040 | 3.6471 | 27,762 |
| 0.45 | 0.406873 | 0.131220 | 3.1007 | 32,654 |
| 0.49 | 0.481255 | 0.175250 | 2.7461 | 36,870 |

**If the cap were divided by $\kappa_q$** (the brief's proposal) the shipped
45-seat floor cap would fall from 101,250 to 21,838–36,870 sats. That would be
*correct* only under the reading where the prize is $\pi$-weighted **and**
$p_{\text{flip}}$ is held fixed — and that reading contradicts itself, because
$p_{\text{flip}} = 1-\pi$.

There are exactly three readings, and the quorum's role differs in each:

| reading | what $\pi$ is | effect of an explicit 3-of-5 | verdict |
|---|---|---|---|
| **the cap as written** — 05 (5.2), prize unweighted | $1$ (no $\pi$ term at all) | none by construction: the quorum is not an input | **SAFE** — a 3-of-5 market cannot loosen a cap that never reads it |
| **$\pi$-weighted, contested through the ladder** (the cap's own assumption, since it derives at the *adjudicating* rung) | composite $\pi = \pi_0\prod_{r\ge1}\pi_r$ | $\kappa_q$ multiplies **one factor** of the product; $\pi_0 \le 1$ and $\prod_{r\ge1}\pi_r \le \pi_1 = 8.504\cdot10^{-3}$ (15 seats, $\rho = ⅓$), so $\pi \le 8.504\cdot10^{-3}$ for **any** round-0 quorum | **SAFE** — both quorums are two orders below the $\pi = 0.2308$ binding threshold, and the deepest rung's quorum is $\lceil 2N/3\rceil$ in both markets anyway |
| **round-0 only** (the undisputed route: a captured round 0 that nobody contests) | $\pi_0$ | 0.2099 vs 0.0453 (05 §1.3); the single-panel cap binds at $\rho = 0.3471$ vs $0.5325$ | cap is **tighter** at 3-of-5 — the quorum's cost here is *capture*, which is 05 §1's table, not the cap |

So the cap is quorum-blind in two successive senses: it has no $\pi$ term, and
the one $\pi$ term that would exist is a product dominated by the *deeper*
panels — where the quorum is $\lceil 2N/3\rceil$ for both markets. $\kappa_q$
cannot move a composite of $8.5\cdot10^{-3}$ across $0.2308$: it multiplies a
factor that is already $\le 1$. **The correction factor is real arithmetic about
the wrong object.** Where the quorum genuinely changes the risk is the two
single-panel thresholds in the table's last row — the ownership capture table
and the P+ε free-attack share — both already published in 05 §1 and §3.

### 3.4 Verdict

> **SAFE for the cap at the shipped ladder — the brief's premise is false.**
> $\kappa_q \in [2.746, 4.636]$ is **slack in the cap's favour**: applying the
> correction would refuse markets that are provably safe. The quorum's real cost
> is two regime *thresholds* — the free-attack share ($\rho$ 0.686 → 0.500) and
> the ownership capture table (0.0453 → 0.2099, 05 §1.3) — both of which are
> already published and neither of which is a cap input.
>
> **What is genuinely wrong is the cap's contract:** (5.2) and (5.6) of 05 use
> $\pi$ inconsistently — (5.6) weights the juror's deviation by $\pi$, (5.2)
> credits the prize unweighted. The published $V_{\max}$ is therefore the
> $\pi = \tfrac12$ slice of a family whose members differ by **141×** over
> $\pi \in [0.5, 0.9]$ (1,425,000 → 114,655). Quoting one number without its
> $\pi$ is the defect; the number itself is not wrong, it is *conditional*.

### 3.5 Fix (shipped)

The arithmetic must stop living in a table. `quorumEconomics.ts` (new, this PR)
is the exact binomial tail and $\kappa_q$ as pure functions of the state the
machine already records:

```ts
captureProbability({ panelSize, quorum, adversaryWeight: { numerator, denominator } })
// → { numerator: 51n, denominator: 243n, value: 0.209877 }   for 3-of-5 at rho = 1/3
quorumCapCorrection({ panelSize: 5, quorum: 3, adversaryWeight: { numerator: 1, denominator: 3 } })
// → 4.63636…  (= 51/11)
```

Additive export, no behaviour change, 13 tests pinning every number in the
tables above (and the 05 §1.3 ladder rows 8.504·10⁻³ / 5.001·10⁻⁶ / 2.735·10⁻¹⁵).
**Registered (host):** (i) state $\pi$ in the cap's contract and keep
$\pi = 1$ (the strictest slice) as the default, so no correction is applied;
(ii) log $\kappa_q$ next to `quorumBelowSupermajority` — it is the number a
pre-flight gate needs when the flag is on, and until now it required re-deriving
a binomial tail at the call site (the R28 defect, one layer up).

---

## 4. r30-4 — decaying commitment against the retainer

### 4.1 Model change

R23 replaced the idle-reset **cliff** with continuous decay (host
`jurorReputationWeight.ts`, review item 3):

$$w(\text{idle}) = w_0 + \big(\text{earned} - w_0\big)\,e^{-\lambda\,\text{idle}},
\qquad \lambda = \frac{\ln 2}{3}\ \text{(half-life 3 idle epochs)},$$

with `earned` recomputed over the **whole** retained record on return (penalties
included, floored at $0.5w_0$: SLA-miss ×0.8, escalation ×0.8, audit ×0.8, and
R23's new confirmed-then-abstained ladder round ×0.8). Theorem 4's model assumed
the composite had **no memory across windows** (Lemma 4.1) and that the weight
had a cliff, not a ramp. The second half of that assumption is now wrong.

### 4.2 The EV computation — the loop, before and after

Take the penalised farmer of Theorem 4.4 in **steady state**: `earned` $= 0.5w_0$
(the floor) in every active epoch. (This is deliberately *not* 04 §4.4's
0.5732·$w_0$ cycle, which starts from a ramping penalty 0.8 → 0.64 → floor; the
question here is what idleness is worth to a juror already at the floor, so the
baseline is flat.) Under the **cliff** the weight held 0.5 for six idle epochs and
epoch 7 restored $w_0 = 1$. Under the **decay** it ramps immediately:

| idle epochs | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 12 | 100 |
|---|---|---|---|---|---|---|---|---|---|
| $w/w_0$ (shipped decay) | 0.500 | **0.603** | 0.685 | **0.750** | 0.802 | 0.843 | 0.875 | 0.969 | → 1.000 |
| $w/w_0$ (cliff, pre-R23) | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 | 1.000 | 1.000 |

The decay is **strictly better for the idling farmer at every epoch**, and
better *immediately*: after one idle epoch the floored juror is at 0.603 and
after three at 0.750, where the cliff still pays 0.500. Long-run weight over a
cycle of $F$ active epochs (at the floor) and $I$ idle epochs, the two regimes
compared at equal cycle length:

$$\bar w(F,I) = \frac{0.5F + \sum_{i=1}^{I}\big(1 - 0.5\,e^{-\lambda i}\big)}{F+I}
\qquad\text{(decay)};\qquad
\bar w_{\text{cliff}} = \frac{0.5F + 0.5\min(I,6) + \max(0,I-6)}{F+I}.$$

| cycle ($F$ active / $I$ idle) | cliff (pre-R23) | shipped decay | $\Delta$ |
|---|---|---|---|
| 6 / 6 (12 epochs) | 0.5000 | 0.6298 | **+26.0 %** |
| 6 / 7 (13 epochs) | 0.5385 | 0.6506 | +20.8 % |
| 1 / 3 | 0.5000 | 0.6345 | +26.9 % |
| 1 / 6 | 0.5000 | 0.7225 | **+44.5 %** |
| 1 / 7 | 0.5625 | 0.7448 | +32.4 % |
| 1 / 12 | 0.7308 | 0.8228 | +12.6 % |
| 1 / 50 | 0.9314 | 0.9525 | +2.3 % |
| idle forever | 1.0000 | 1.0000 | 0 |

> **Finding 4.1 (the fix dominates the cliff it replaced).** The decay's average
> weight is **strictly greater than the cliff's at every finite cycle length**,
> and both converge to $w_0$ in the limit. The cliff's only cost to the farmer
> was the six-epoch wait for the reset; the decay removes the wait and keeps the
> endpoint. A penalty is now something a juror can **out-wait**, and the cheapest
> way to do it is to stop participating — which is the behaviour the retainer
> exists to price.

The shipped module's own docstring says *"Under continuous decay that loop
monotonically loses weight instead of regaining any"*. The shipped test
`jurorReputationWeight.decay.test.ts` › **P2** asserts the opposite — *"a
penalised juror is strictly increasing, bounded above by w0"* — and P3 pins
`far.weight > w0 − 1e-9` at idle 200. The comment and the code disagree; the code
is what ships, and the code is what the table above measures.

### 4.3 The retainer half — unchanged, and that is the finding

The retainer is paid on a **window-local** metric with no memory at all:

$$S = a_r\Big(\tfrac12 + \tfrac12 p_r\Big) \ge \tau .$$

Decay prices *idleness*; the retainer prices *activity inside one window*. A
juror therefore needs to be active only in the windows it wants paid, and holds
its weight between them. The optimal participation rate is still Theorem 4's
corner, **unchanged by $\lambda$**:

$$p^{*} = \max(0,\,2\tau - 1), \qquad S(p^{*}) = \max(\tau, 0.5).$$

| $\tau$ | 0.50 | 0.60 | 0.75 | 0.90 | 1.00 |
|---|---|---|---|---|---|
| $p^{*}$ | **0.00** | 0.20 | 0.50 | 0.80 | 1.00 |

And the **pure ack-farmer is untouched by decay**, exactly as Theorem 4.4's
first bullet says: its `earned` weight is $w_0$ (ackRate 1 ⇒ no SLA penalty, no
confirmations ⇒ bonus 1, no ladder rounds ⇒ no non-participation penalty), so
$w_0 + (w_0-w_0)e^{-\lambda\cdot\text{idle}} = w_0$ for every idle distance. Its
ceiling is Corollary C4.1 ($\tau \le 0.5 \Rightarrow$ full retainer at zero
participation), and **no value of $\lambda$ changes it**.

What the decay *does* interact with is the **penalised** farmer — the one R23
item 2 gave a real penalty (confirmed-then-abstained ladder rounds). Its steady
state is $0.5w_0$; the decay hands it back up to $w_0$ for idling. So the retainer
farm has a new optimum in two dimensions (participation $p$, activity cadence),
and the cadence dimension is free:

$$\bar\pi_{\text{farmer}} = \underbrace{\frac{R_{\text{ret}}}{k}}_{\text{1 window in } k} + \underbrace{\frac{w(\text{idle})}{\sum_j w_j}\,\Phi_{\text{fees}}}_{\text{selection flow}} \quad\longrightarrow\quad k^{\ast} = \arg\max_k,$$

and with $w$ rising in idleness while $R_{\text{ret}}$ falls as $1/k$, the
optimum is interior — i.e. **the farmer's best play is part-time attendance**,
which is precisely the Goodhart behaviour the retainer exists to prevent.

### 4.4 Verdict

> **EXPLOITABLE (r30-4), bounded by the floor.** The fix removes the *cliff* and
> replaces it with a *ramp*: a penalised juror's weight is non-decreasing in
> idleness, and the ramp's average weight dominates the cliff's at **every finite
> cycle length** (+26.0 % at 6 active/6 idle, +44.5 % at 1/6, +12.6 % at 1/12),
> converging to the same endpoint ($w_0$) as the cliff did. The loop's value is
> therefore not removed; it is made **cheaper to execute** — the 6-epoch wait,
> which was the cliff's entire deterrence, is gone. The retainer optimum is
> untouched — $p^{*} = \max(0,2\tau-1)$ — because the retainer metric has no
> memory for decay to act on. The pure ack-farmer is entirely unaffected.

### 4.5 Fix

**Registered, host, one expression.** Decay must **anchor** at the direction it
should move:

```ts
const anchor = earnedWeight >= w0 ? w0 : P.minWeightFactor * w0;   // <- the fix
const weight = anchor + (earnedWeight - anchor) * decayFactor;
```

- `earned ≥ w0` (a bonus): $w = w_0 + (\text{earned}-w_0)e^{-\lambda\,\text{idle}}$
  — unchanged, the bonus fades.
- `earned < w0` (a penalty): the weight decays **toward the floor**, not toward
  probation. A floored juror stays exactly at $0.5w_0$ forever while idle
  (0.5 + 0·e^{−λi}); a mildly-penalised one (0.8) drifts *down* to 0.5.

Loop value with the anchor: **0.000** at every $(F,I)$ (the 1/12 cycle falls
from 0.8228 to a flat 0.5000). Recovery then requires *participation* — which is
the only recovery path an honest juror needs.

**Companion (registered, host, required for fairness).** With the anchor, a
single bad epoch would pin a juror at $\le 0.8w_0$ for as long as its record is
retained, because the penalty product is over **all** retained epochs. Penalties
must therefore leave the product by *ageing* (a sliding window over the last
$K$ epochs, or a penalty-factor decay of its own). The current design has no
penalty expiry other than the decay the anchor removes — so the two changes ship
together or not at all. State it that way in the host PR; the anchor alone is a
regression in fairness.

> **Landed in v0.13.0 (R31), package side.** `penaltyAging.ts` ships the pair:
> `pairedJurorWeight` implements the anchor above, and
> `agePenalties(penalties, epochs)` ages every retained penalty at the SAME
> $\lambda = \ln 2/3$ **on the participating clock**, so recovery is bought
> with participation and idling never hands weight back. Pinned against §4.2:
> the paired cycle average is the floor at every split (0.5000 at 6/6, versus
> the shipped ramp's 0.6298) and is never worse than the ramp at any split. The
> host still owns the wiring (retained record → `PenaltyRecord[]`, and
> `jurorReputationWeight`'s anchor line).

---

## 5. r30-5 — the shadow-mode asymmetry

### 5.1 The question, and what the label can carry

In `shadow` mode the creation gate records
`bao_court_econ_ratio_would_reject_total{rail,reason}` and a structured
`would_reject` line carrying `market_value_sats`, `ratio`, `panel_size`,
`adjudicating_round`, `gamma`. Every one of those is derivable from public data
(the market's own declared liquidity, the published cap, the operator's ladder
config, which the refusal message in `enforce` mode quotes verbatim). **The label
is derived arithmetic, not hidden state** — the round-3 conclusion (`REVIEW_ROUND_3.md`
§2.4) stands, and there is no information asymmetry to arbitrage.

The asymmetry that *is* real is **temporal**, and the R30 freeze created it:

1. a market created in `off`/`shadow` is **never re-checked**;
2. R30 pins its cohort config on the row, so a later `enforce` + a *lowered*
   env cannot tighten it — the freeze deliberately makes the env change apply to
   new markets only (`resolveCourtLadderFreeze`);
3. the `would_reject` ledger is a **creation-time** counterfactual, so it does
   not list the markets that grew *after* creation — exactly the population r29-7
   was about.

So the arbitrage window is: *create at any value while the gate is off, and the
flip is not retroactive.* Its value is bounded by how much the created market
could put at risk.

### 5.2 The bound

The grandfathering is **not** an economic breach on its own, and this is the
part worth stating: a market frozen at a config with $N_{\text{cfg}} \ge 112$ is
**scale-free** — $\gamma\sigma N \ge 1$ holds at *every* $V$ because the stake
schedule scales with the value. At 135 seats $\gamma\sigma N = 1.215$, so an
unbounded cap is the *correct* cap, not a loophole. The freeze therefore cannot
be exploited to hold an under-collateralised market — **unless the cohort
shrinks**, which is r30-2. The two compose:

$$\text{grandfathered market} + \text{cohort churn} = \text{the 2.47× breach of §2, frozen in place.}$$

The stale-ledger half has a clean bound too: in `enforce` mode a deposit that
would breach the cap is refused (`ECON_RATIO_EXCEEDED_ON_LIQUIDITY`, assessed
against `markets.liquidity + liquidity_l`), so a grandfathered over-cap market
**cannot grow**. The arbitrage is worth at most its creation-time exposure:

| mode at creation | max value creatable | can it grow later (enforce)? |
|---|---|---|
| `off` (the default) | unbounded | no — deposits re-assessed |
| `shadow` | unbounded, **recorded** | no |
| `enforce` | the frozen cap | no |

So the honest accounting: `off` is the exposure, `shadow` is strictly *more*
informative than `off` (it records the counterfactual volume), and the flip is
non-retroactive for one market, one time — with the residual risk being stale
inventory, not a live lever.

### 5.3 Verdict

> **SAFE on the label** (no secret, no priceable information: §5.1) and
> **EXPLOITABLE-lite on grandfathering**, bounded by (i) the frozen config being
> scale-free at $N \ge 112$ ($\gamma\sigma N = 1.215$ at 135) and (ii) deposits
> being re-assessed in `enforce` mode. The compound case is r30-2's churn, which
> is where the 2.47× lives. The genuine residual is **audit staleness**: the
> shadow ledger is creation-time, so the operator flipping to `enforce` has no
> list of live markets that are over-cap *now*.

### 5.4 Fix

**Registered, host (small).** A boot + periodic **inventory sweep**: for every
live market, re-run `assessCourtEconomicRatio` with the **frozen** cohort
(`resolveCourtLadderFreeze`) and the **current** exposure
(`resolveCourtMarketExposureSats`), and refuse to boot (or open an incident)
on any violation. Every input already exists; this is a call-site, not new
arithmetic. It converts the shadow ledger from "what creation would have
refused" into "what is out of bounds today", which is the number an operator
actually needs at flip time.

---

## 6. The reviewer's summary table

| # | Attack | Model change | Extremum / EV | Verdict | Fix state |
|---|---|---|---|---|---|
| r30-1 | one bond funds every escalation | $\Delta C_{r+1}: 3^{r+1}b_0 \to 0$ | farming EV $\le -0.024V$ at $R{=}1$ rises to $-0.0186V$ ($R{=}2$), $-0.00543V$ ($R{=}5$); flip round 7 at $a_f{=}0.9$ but 5 at 0.85, 3 at 0.75; venue/griefer 0.86× at $R{=}2$ → **54.1×** at $R{=}5$ | **EXPLOITABLE** (option unpriced); farming sign **SAFE** ($R<6.58$ today) | wire `v0.13` + host `calculateBondAmount`; rule `maxLadderRounds ≤ ⌊ln(ρ/(ρ+β))/ln a_f⌋` |
| r30-2 | frozen ladder, shrinking cohort | $n_{\text{act}} \le N_{\text{cfg}}$ | $N_{\min}(V)$ = 23/45/112/112/112; $135{\to}45$ = **2.47×** short; cap falls to 101,250 sats (9.88× over on 1 M) | **EXPLOITABLE at host** | host: cohort check + $\min(\text{cap})$ at creation/deposit; machine `v0.13`: roster growth rule |
| r30-3 | 3-of-5 vs the cap | $\pi$ explicit; $p_{\text{flip}} = 1-\pi$ | cap = the $\pi{=}\tfrac12$ slice (1,425,000 at $t{=}30$, exact); $V_{\max}$ ↓ in $\pi$ (141× over $\pi\in[0.5,0.9]$); $\kappa_q = 2.75$–$4.64$ | **SAFE** — $\kappa_q$ is slack; the cap binds at $\rho$ 0.5325 (4-of-5) vs 0.3471 (3-of-5) | **SHIPPED** `quorumEconomics.ts`; host: state $\pi$, log $\kappa_q$ |
| r30-4 | decay ramp vs the retainer | weight has memory, metric does not | ramp average 0.6298 vs the cliff's 0.5000 (6/6), 0.7225 vs 0.5000 (1/6) — **dominates at every finite cycle**; retainer optimum unchanged at $p^{*}{=}\max(0,2\tau-1)$ | **EXPLOITABLE** (the fix raised the loop's value) | host: anchor the decay at the floor + penalty ageing (must ship together) |
| r30-5 | shadow mode / grandfathering | temporal, not informational | frozen 135 config is scale-free ($\gamma\sigma N{=}1.215$); deposit re-assessment caps growth; residual = stale inventory | **SAFE** on the label; **EXPLOITABLE-lite** via r30-2 | host: boot/periodic inventory sweep |

**Two of five are SAFE.** That is the useful part of a re-verify: r30-3's
premise fails its own algebra (the correction runs in the mechanism's favour),
and r30-5's asymmetry is temporal and bounded rather than an information leak.
The three that are not are all *price* defects — an option given away free
(r30-1), a collateral ratio measured against a panel that need not exist
(r30-2), and a deterrence ramp that pays the defector for waiting (r30-4).

---

## 7. Changes shipped here, and changes registered

### 7.1 Shipped in this PR

| # | Artefact | Change | Closes |
|---|---|---|---|
| S1 | `quorumEconomics.ts` (new) | exact binomial capture tail + $\kappa_q$ as pure functions; fails closed on malformed input; documents that the cap is **not** divided by $\kappa_q$ | r30-3's arithmetic (was a doc table) |
| S2 | `__tests__/quorumEconomics.test.ts` (new, 13 tests) | pins 51/243, 11/243, 51/11 = 4.6364, the $\kappa$ table, the 05 §1.3 ladder rows, monotonicity, and the fail-closed contract | r30-3 regression |
| S3 | `index.ts` | additive export of `captureProbability`, `quorumCapCorrection` (+2 types) | host consumption |
| S4 | `docs/proofs/economics/06-expert-verify.tex.md` (this file) | the five attacks, their EVs, verdicts and registered fixes | round 30 (2 of 2) |
| S5 | `scripts/review-quant/economics.mjs` §6 | every number in §1–§5, reproducible | the file's standing promise |
| S6 | `README.md`, `00-model`, `02-ladder`, `04-goodhart`, `REVIEW_ROUND_3.md` §9, `CHANGELOG.md` | the new surfaces, the corrected claims, r29-3's status change | doc drift |

No protocol parameter changes: $\gamma$, $\lambda$, $\sigma$, $s_0$,
`maxLadderRounds`, $\lceil 2N/3\rceil$ and $\tau$ keep their shipped values.
`quorumEconomics.ts` is pure and additive; no existing export changed, no
behaviour changed, so no consumer breakage.

### 7.2 Registered (not fixed here)

| # | Residual | Severity | Where the fix goes |
|---|---|---|---|
| r30-1a | the escalation bond is a membership test, not a consumption test — one bond funds every round | **MAJOR** (economic; bounded at 5 rounds) | `bao-court` v0.13: `accept_challenge.round` + `escalate.bondRound` + log monotonicity |
| r30-1b | the spec's ladder triples ($3^{r}$) while `escrow.ts:117–129` doubles ($2^{r-1}$) | MEDIUM | reconcile `calculateBondAmount` with 05 §5.3 before wiring r30-1a |
| r30-1c | the ladder cap is a constant while the option's sign depends on the **measured** $a_f$ | MEDIUM (policy) | host pre-flight: $a_f$ measurement + $\texttt{maxLadderRounds} \le \lfloor \ln(\rho/(\rho+\beta))/\ln a_f\rfloor$ |
| r30-2a | the frozen cohort config is never compared with the eligible cohort | **MAJOR** (host) | `bao.markets`: cohort check at escalation + `min(cap)` at creation/deposit |
| r30-2b | `open_ladder_round` accepts a round roster of 3 seats for a round-2 rung | MEDIUM | `v0.13`: enforce `≥ round0 · 3^{round}` with the event-shape work |
| r30-3a | the cap quotes one number without its $\pi$; (5.2) and (5.6) of 05 weight $\pi$ inconsistently | MEDIUM (contract) | host: state $\pi$, default 1, log $\kappa_q$ |
| r30-4a | idle decay is anchored at $w_0$ in both directions, so idleness never lowers a penalised weight | **MAJOR** (economic) | host: `anchor = earned >= w0 ? w0 : floor` (one line) |
| r30-4b | penalties never expire from the product; the anchor alone would pin a single bad epoch | **MAJOR** (paired with r30-4a) | host: sliding penalty window / penalty decay |
| r30-5a | shadow ledger is creation-time; no inventory of live over-cap markets | LOW (host audit) | host: boot + periodic sweep on frozen config × current exposure |

---

## 8. What is NOT proved here (this round's ledger)

1. **$c_s$ is a measurement, not a constant.** Every venue figure in §1.4 is
   linear in the per-summon operational cost, which is a deployment datum. The
   *structure* — the venue's cost grows $3^{r}$ while the challenger's is flat —
   is unconditional; only the multiplier is not.
2. **$a_f = 0.9$ is A4, not a measurement.** §1.3's flip round moves with it:
   at $a_f = 0.85$ the flip is at $R = 5$ (the protocol cap becomes profitable),
   at $a_f = 0.75$ at $R = 3$, at $a_f = 0.70$ at $R = 2$ (the shipped cap).
   A jury-quality regression converts r30-1 from "deterrence diluted" to
   "deterrence inverted", which is why §1.5 ships the cap rule
   $\texttt{maxLadderRounds} \le \lfloor \ln(\rho/(\rho+\beta))/\ln a_f\rfloor$
   rather than a constant. This is the single most important dependency in this
   file, and it is the same $a$ that governs T1's guard and T2's $r^{*}$.
3. **The composite $\pi$ bound assumes the deeper rounds are not perfectly
   correlated** (05 GAP-5a). §3.3's "$\pi \le \pi_1 = 8.504\cdot10^{-3}$ for any
   round-0 quorum" uses the product form; if jury errors correlate across rungs,
   the composite behaves like the *largest* per-round capture probability rather
   than the product, and a market could cross the $\pi = 0.2308$ binding
   threshold. The conclusion survives in the direction that matters — a lower
   round-0 quorum still moves first, because it raises $\pi_0$ and nothing else —
   but the *placement* of both quorums in the unbounded region does not.
4. **$\rho$ is unobservable** (05 GAP-5b). $\kappa_q$ is a function of it, so
   the $\kappa_q$ table is a parameterised threat surface, not a measurement.
5. **The retainer cadence is undefined in code.** §4.3's $k$ (windows per
   retainer payment) is not pinned anywhere in either repository — it is the
   operator's scheduler. The 1-in-6 and 1-in-12 rows are illustrations, and the
   optimum's *existence* is what the finding rests on, not its location.
6. **$N_{\text{el}}$ is not published.** §2.4's guard needs the current eligible
   cohort size per market; `filterEligibleJurors` computes the set but the count
   is not exposed as a metric. The guard is one query away but not zero.
7. **The venue cost ignores the panel's own loss.** A forced round also consumes
   honest jurors' attention and stakes; the model prices the operator's work and
   the fee floor, not the cohort's opportunity cost (which Corollary 2.1 says is
   compensated).
8. **r30-1's EV assumes the bond is returned on a win.** If the host forfeits
   the bond on any lost *round* rather than on a lost *case*, the option is not
   free and the erosion vanishes; the closed-budget ledger's `bond_forfeit`
   inflow is per case, and `CourtEscalationService` carries one bond per case,
   which is what this file assumes.

---

## 9. Reproduction

```bash
node scripts/review-quant/economics.mjs          # §1–§5 (05) and §6 (this file)
npx vitest run __tests__/quorumEconomics.test.ts  # 13 tests: every κ and tail number
```

Deterministic and dependency-free: exact BigInt rational arithmetic for every
probability (the capture tails are exact fractions over $\rho_{\text{den}}^{N}$),
IEEE doubles only for the money tables, printed as integers after rounding and
stable to the sat at these magnitudes.
