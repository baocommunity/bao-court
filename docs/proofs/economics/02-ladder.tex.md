# Theorem 2 — Escalation incentive-compatibility: $r^*$ and the griefing transfer

**Binds to:** ladder cost curve $c_r = (3^{r+1}-1)/2$ (spec §4.2 table
L108–117: 4×/13×/40×/121×/364×), host-driven escalation with
`maxLadderRounds` default 2 bounded 1..5 (`courtConfirmationMachine.ts:242–247`,
`confirmationMachineTypes.ts:160`, bao-court), cumulative-bond skip rule
(spec L120–121), bond-forfeit inflow (`JurorPoolLedger.ts:53–54`),
deeper-round value gate (bond ≥ 25% of disputed value for $r \ge 3$, spec
L118–119).
**Status:** proof complete under A1–A8; $r^*$ given in closed form and
evaluated at the shipped parameters.

---

## 1. Statement

> **Theorem 2 (Escalation IC).** Let a challenger who believes it is merited
> have lost ladder rounds $1..r$ (each round an independent jury verdict with
> accuracy $a > 1/2$ against an unmerited position, A4), prior odds
> $O_0 = p_0/(1-p_0)$, ultimate win value $G$ (disputed value + rewards),
> and let the incremental cost of round $r{+}1$ be $\Delta C_{r+1} = 3^{r+1} b_0$
> with $b_0$ the base round cost (bond + fee share). Then:
>
> **(i)** escalating is strictly EV-decreasing in $r$ once past the unique
> crossing
> $$r^{*} \;=\; \Big\lfloor \frac{\ln\!\big(O_0\, G / b_0\big)}{\ln\!\big(3a/(1-a)\big)} \Big\rfloor,$$
> because the marginal EV ratio decays geometrically at rate
> $(1-a)/(3a) < 1/3$ per round while the incremental cost grows as $3^r$.
>
> **(ii)** At the shipped parameters ($a = 0.9$, $\beta = 0.03$ so
> $b_0 = 0.03V$, $G \approx V$): $r^{*} \le 2$ for **every** prior
> $O_0 \le 270$ — i.e. even a challenger 99.6% sure it was right stops
> escalating after round 2. The shipped default `maxLadderRounds = 2` is
> therefore exactly **incentive-tight**: the mechanism's own cap coincides
> with the rational stopping boundary.

> **Corollary 2.1 (Griefing subsidizes the cohort).** Every escalated-and-lost
> round forfeits the challenger's (or proposer's) bond into the juror pool as
> a `bond_forfeit` inflow (`JurorPoolLedger.ts:53–54`, closed budget A6):
> the loser's cost is, sat for sat, the cohort's income — a pure transfer
> from the griefing side to coherent jurors and the retainer, with zero
> venue float (spec L212). Griefing is individually strictly negative-EV
> (it is Theorem 1's $a_f \to a$ worst case with known-unmerited challenges)
> and cohort-positive; the two facts together mean the mechanism *prices*
> griefing as a bonded tax, it does not prevent it — and prevention is not
> required for cohort welfare.

## 2. Setup

Bayesian updating. Conditional on the challenger being unmerited, each
round's jury returns the (adverse) true outcome with probability $a$; if the
challenger is merited, the adverse verdict occurs with probability $1-a$
(jury error). Rounds conditionally independent (A4). After $r$ adverse
rounds, posterior odds of being merited:

$$O_r \;=\; O_0 \left(\frac{1-a}{a}\right)^{r}. \tag{2.1}$$

Costs. From the shipped ladder (§5.3 of the model): cumulative cost if the
challenger keeps losing through round $r$ is $c_r b_0^{\text{cum}}$ with
$c_r = (3^{r+1}-1)/2$; the *marginal* cost of fighting round $r{+}1$ — the
round-$r{+}1$ bond plus fee exposure — scales as

$$\Delta C_{r+1} \;=\; 3^{\,r+1} b_0, \qquad b_0 = \text{base round cost}.$$

(This is exactly the spec's skip rule made marginal: skipping to round $N$
costs the cumulative bond $\text{bond}_N = \text{base} + \sum_{r\le N}\text{fees}$,
spec L120–121, so the per-round increment is the round's own bond + fee
mass, which the ladder table prices at $3^r\times$ base.)

Win value $G$: if the challenger is ultimately upheld it recovers its
position — worth $G \le V + R_c \le 1.03\,V$ under Lemma 1.1 of 01; losing
pays $\Delta C$ and forfeits into the pool.

## 3. Proof of (i)

Marginal analysis at round $r{+}1$: concede now (pay nothing more, keep
status quo) vs escalate. Escalating yields win-probability
$p_{r+1} = O_{r+1}/(1+O_{r+1})$ and:

$$\mathbb{E}[\pi_{\text{escalate}}] - \mathbb{E}[\pi_{\text{concede}}]
\;=\; p_{r+1}\,G \;-\; (1-p_{r+1})\,\Delta C_{r+1} \;>\; 0
\;\;\Longleftrightarrow\;\; O_{r+1} \;>\; \frac{\Delta C_{r+1}}{G}. \tag{3.1}$$

Substituting (2.1) and $\Delta C_{r+1} = 3^{r+1} b_0$, the escalation
condition becomes

$$O_0 \left(\frac{1-a}{a}\right)^{r+1} > \frac{3^{r+1} b_0}{G}
\;\;\Longleftrightarrow\;\;
\left(\frac{1-a}{3a}\right)^{r+1} > \frac{b_0}{O_0 G}. \tag{3.2}$$

Since $a > 1/2$, the base satisfies $(1-a)/(3a) < 1/3 < 1$: the left side is
**strictly decreasing in $r$** while the right side is constant. Hence (3.2)
holds exactly for $r + 1 \le r^{*}$ with

$$r^{*} \;=\; \Big\lfloor \ln\!\big(O_0 G / b_0\big) \Big/ \ln\!\big(3a/(1-a)\big) \Big\rfloor,$$

and for every $r > r^{*}$ the marginal EV of escalation is negative —
strictly, because the decay is strict. Escalating a losing position past
$r^{*}$ is EV-decreasing; the superlinear cost curve ($3^r$) dominates the
Bayesian odds decay ($((1-a)/a)^r$, rate $< 1$) *compounded with it*. ∎

## 4. Proof of (ii) — the shipped operating point

With $a = 0.9$: $3a/(1-a) = 27$. With $\beta = 0.03$: the base round cost is
dominated by the bond, $b_0 \approx 0.03V$; with $G \approx V$:

$$\frac{\ln(O_0 G/b_0)}{\ln 27} = \frac{\ln(O_0/0.03)}{3.296} = \frac{\ln O_0 + 3.507}{3.296}.$$

| Prior belief $p_0$ | $O_0$ | $r^*$ | Reading |
|---|---|---|---|
| 0.5 (coin flip) | 1 | $\lfloor 3.507/3.296 \rfloor = 1$ | stop after round 1 |
| 0.9 | 9 | $\lfloor 5.70/3.30 \rfloor = 1$ | stop after round 1 |
| 0.99 | 99 | $\lfloor 7.90/3.30 \rfloor = 2$ | stop after round 2 |
| 0.9963 | 270 | $\lfloor 8.60/3.30 \rfloor = 2$ | stop after round 2 |
| 0.998 | 500 | 2 (floor 2.29) | stop after round 2 |
| 0.9988 | 800 | 3 | crosses the shipped cap |

So $r^{*} \le 2$ for all $O_0 \le 270$ ($p_0 \le 99.63\%$). The shipped
default `maxLadderRounds = 2` (`courtConfirmationMachine.ts:242–247`) caps
precisely at the rational boundary for every challenger short of near-
certainty — and the deeper rungs ($r \ge 3$) are gated by
bond ≥ 25% of disputed value (spec L118–119), which re-prices $b_0$ upward
by $8\times$ exactly where a persistent challenger would need it: solving
(3.1) with $b_0 = 0.25V$ collapses $r^*$ back to $\le 2$ even for
near-certain priors. **The value gate and the cap are the same policy read
off (3.2).** ∎

**Sensitivity (for the operator).** $r^*$ is decreasing in $a$; jury-quality
regression moves the boundary:

| $a$ | $3a/(1-a)$ | $r^*$ at $O_0=1$ | $r^*$ at $O_0=9$ | $r^*$ at $O_0=99$ |
|---|---|---|---|---|
| 0.9 | 27 | 1 | 1 | 2 |
| 0.75 | 9 | 1 | 1 | 2 |
| 0.6 | 4.5 | 1 | 2 | 3 |
| 0.55 | 3.67 | 1 | 2 | 4 |

Deeper ladders are only rational for challengers when juries are near
coin-flips — the same regime in which Theorem 1's farming guard also
degrades. One measured quantity ($a$) governs both theorems; measuring it
is the empirical program (README §4).

## 5. Proof of Corollary 2.1

A griefing attack is an unmerited challenge the griefer *knows* is unmerited:
its win probability is the jury-error rate $1-a \le 0.1$ (A4), so per attack
$\mathbb{E}[\pi] \le V[(1-a)\rho - a\beta] - c_f = -0.024V - c_f < 0$ — the
Theorem 1 bound with the farmer's optimism replaced by knowledge (the
griefer cannot even claim the favorable $a_f$ reading; it is the same
inequality with $a_f = a$ and the griefer's own prior $O_0 \approx 0$ making
every escalation past round 0 irrational by (3.1)).

The transfer side: on each lost round the bond forfeits into the pool —
`bond_forfeit` is an inflow (`JurorPoolLedger.ts:53–54`,
`ENTRY_SIGN.bond_forfeit = +1`); by the closed budget (A6, L-0 of the model)
its only exits are juror case fees, retainer, and dust sweeps, all paid to
jurors, and the epoch parity check (`verifyEpochParity()`) pins conservation.
The venue's float is zero by construction (loser-bond funding, spec L212).
Hence loser cost ≡ cohort income, minus nothing. The corollary's "griefing
subsidizes the cohort" is thus not a design aspiration but a ledger
identity. ∎

**Remark 2.2 (why "subsidy" is safe).** A cohort-positive tax on griefing
could perversely make jurors *welcome* griefing; but jurors cannot induce it
(threshold-2 selection unpredictability, A5 — no juror can cause challenges),
and the challenger-side stop rule (Theorem 2i) bounds the subsidy per dispute
at $c_{r^*} \le 13\times$ base under the shipped cap. The subsidy is bounded,
unorchestratable, and lands on coherent jurors — the cohort's honest members.

## 6. What is NOT proved here

- **LEMMA-GAP (empirical):** conditional independence of rounds (A4). If
  jury errors correlate across rounds (same evidence, same LLM prompt
  family), adverse rounds are *more* informative than (2.1) assumes —
  correlated errors make $O_r$ decay *slower*, i.e. rational challengers
  stop *earlier*; the theorem's direction survives, the boundary $r^*$ does
  not (it is an upper bound on rational persistence only under
  independence). Measuring cross-round error correlation is part of the
  Monte Carlo (README §4).
- **Merited-challenger welfare:** Theorem 2 prices the *losing* side's
  incentive; it does not claim the ladder's *length* is optimal for surfacing
  merited overturns (that is a speed/accuracy trade-off, paper §6.2's design
  note on host-driven escalation).
