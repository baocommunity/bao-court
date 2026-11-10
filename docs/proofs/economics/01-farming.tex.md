# Theorem 1 — Challenge-farming is negative-EV at the shipped parameters

**Binds to:** challenger-bond schedule (spec-pinned $\beta = 3\%$, symmetric,
spec L213–214), loser-bond funding $\ell = 2\%$ (spec L212), closed-budget
ledger (`JurorPoolLedger.ts`, bao.markets), reputation caps
(`jurorReputationWeight.ts:52–56`), escrow-before-validity
(`BaoCourtService.ts:340–373` bao.markets; ledger lock paper §8.2).
**Status:** proof complete under A1–A8; the flip boundary is stated in closed
form (§5) — that boundary IS the operator's tuning guard.
**Premises:** model + assumptions A1–A8 of [`00-model.tex.md`](00-model.tex.md).

---

## 1. Statement

> **Theorem 1 (Farming negative-EV).** Fix the shipped parameters
> ($\beta = 0.03$ challenger-bond ratio, $\rho \le 0.03$ challenger-reward
> ratio bounded by the loser-bond budget, closed budget A6). Let $a_f$ be
> the jury's probability of returning the true outcome on a *manufactured*
> (unmerited) challenge, $a_f \ge a^*$ (A4). Then the expected payoff of one
> challenge-farming attack is
>
> $$\mathbb{E}[\pi_{\mathsf{farm}}] \;=\; (1-a_f)\,R_c \;-\; a_f\,B_c \;-\; c_f
> \;\;\le\;\; V\big[(1-a_f)\,\rho - a_f\,\beta\big] \;-\; c_f,$$
>
> which is **strictly negative** whenever
>
> $$a_f \;>\; a^{\dagger} \;=\; \frac{\rho}{\rho+\beta}
> \qquad\big(\text{equivalently } \beta > \rho\,\tfrac{1-a_f}{a_f}\big),$$
>
> and at the shipped numbers ($\rho \le 0.03$, $\beta = 0.03$) the boundary
> is $a^{\dagger} \le 1/2$: any jury that is right on manufactured disputes
> **more often than a coin flip** makes farming strictly loss-making.
> Under A4 ($a_f \ge 0.9$) the per-attack EV is at most
> $V(0.1\rho - 0.9\beta) - c_f \le -0.024\,V - c_f < 0$: **at least 2.4% of
> the disputed value burned per attack, before coordination costs.**

The flip region — where the inequality reverses — is characterized in §5
and is the stated tuning guard: raise $\beta$, or cut the challenger reward
share $\rho$, or (the honest lever) degrade $a_f$ is *not* an option — it is
measured, not set.

## 2. Setup

A **challenge-farmer** files unmerited challenges against *correctly*
resolved outcomes at rate $\nu$ attacks per epoch, with disputed value
$V$ chosen by the farmer (worst case for the mechanism: optimal $V$).

Per attack, the farmer:

1. escrows the challenger bond $B_c = \beta V$ **before** the challenge is
   valid (A9; fatal-mistake (1) spec L226 — no valid challenge without
   escrow);
2. wins with probability $1 - a_f$ (the jury errs; A4), earning the
   challenger reward $R_c$ — bounded by the loser-bond budget (Lemma 1.1);
3. loses with probability $a_f$, forfeiting $B_c$ into the juror pool as a
   `bond_forfeit` inflow (`JurorPoolLedger.ts:53–54`);
4. pays operating cost $c_f \ge 0$ per attack (bond capital float, evidence
   fabrication, key management).
5. optionally also sits as a juror; that income channel is *independent of
   farming* (selection is reputation-weighted and unpredictable, A5) and is
   bounded by Lemma 1.3 — farming does not relax it.

## 3. Lemmas

> **Lemma 1.1 (Reward bounded by the closed budget).** The challenger reward
> on a won challenge satisfies $R_c \le B_p - \ell^{\ast} \le \beta V$, where
> $B_p = \beta V$ is the proposer's forfeited bond and $\ell^{\ast} \ge 0$
> is the panel fee mass funded from it (spec L200–201: challenge wins →
> proposer's bond funds the larger fee). With the shipped fee split
> ($\ell = 0.02V$ fee mass, $B_p = 0.03V$), $R_c \in [0.01V,\ 0.03V]$.
>
> *Proof.* Every sat paid to the challenger on a won challenge originates in
> the proposer's forfeited bond: by A6 (`JurorPoolLedger.ts` entry signs,
> lines 52–62) the only inflows are `fee_accrual`, `bond_forfeit`,
> `case_credit`, and the case's own bond is the only new `bond_forfeit` on a
> rejected dispute. The ledger's never-negative guard (`:229–233`,
> `JUROR_POOL_BUDGET_EXCEEDED`) forbids paying the challenger more than the
> case's forfeited bond minus the fee mass already committed to the panel.
> Hence $R_c \le B_p = \beta V$; the fee-diluted floor $0.01V$ is the spec's
> split ($0.03V$ bond − $0.02V$ fees). ∎

> **Lemma 1.2 (Bond/reward asymmetry is shipped, not incidental).**
> $\beta = 0.03$ applies symmetrically to proposer and challenger
> (spec L213–214: "symmetry kills farming EV" is the design's own stated
> reason), while the *reward* side is a residual of the loser's bond after
> panel fees. So $\rho \le \beta$ always: the challenger risks strictly more
> than the maximum it can extract, per attack.

> **Lemma 1.3 (The compounding asset is bounded — no runaway reinvestment).**
> A farmer who converts farming proceeds into juror income via the
> contribution bonus has selection weight
> $w \le w_0 \cdot 1 \cdot \Pi\pen \cdot (1 + \lambda \sum c_e 0.9^{\text{age}})$
> with caps 4/epoch and 24 lifetime, most-recent-first
> (`jurorReputationWeight.ts:319–323`). The weighted sum is maximized by
> packing all 24 contribution events into the 6 most recent epochs (per-epoch
> cap 4, recency 0.9^age, lifetime cap reached before age 7):
> $\sum c_e 0.9^{\text{age}} \le 4\sum_{a=0}^{5} 0.9^a = 4\cdot\frac{1-0.9^6}{0.1} = 18.74$,
> so the bonus is at most $1 + 0.15 \times 18.74 = 3.81$, and with the
> penalty floor (`:332–335`)
>
> $$0.5\,w_0 \;\le\; w \;\le\; 3.81\,w_0 .$$
>
> *Proof.* Direct computation on the shipped caps; the most-recent-first
> tie-break (`:317–323`) makes the recency-weighted sum maximal under the
> lifetime cap exactly as stated (documented in-code as "the
> maximal-honesty choice"). The floor applies to the penalty product only,
> the bonus cannot buy back below-floor penalties (`:330–335`). ∎
>
> **Remark.** The same bound caps the *colluder's* compounding asset
> (Theorem 3, Remark 3.3): no strategy can push selection weight beyond
> $3.81\,w_0$, so no strategy can convert proceeds into unbounded future
> income. Farming cannot snowball.

## 4. Proof of Theorem 1

Per attack (§2), with $a_f$ the jury-accuracy on manufactured disputes:

$$\mathbb{E}[\pi_{\mathsf{farm}}] = (1-a_f)\,R_c + a_f\,(-B_c) - c_f.$$

Substituting the bounds $R_c \le \rho V$ (Lemma 1.1, $\rho \le \beta = 0.03$)
and $B_c = \beta V$:

$$\mathbb{E}[\pi_{\mathsf{farm}}] \;\le\; (1-a_f)\rho V - a_f \beta V - c_f
\;=\; V\big[\rho - a_f(\rho+\beta)\big] - c_f.$$

The bracket is negative iff $a_f > \rho/(\rho+\beta) = a^{\dagger}$. At the
shipped numbers $\rho \le \beta = 0.03$:

$$a^{\dagger} = \frac{\rho}{\rho + 0.03} \;\le\; \frac{0.03}{0.06} \;=\; \frac12 .$$

Under A4, $a_f \ge 0.9 > 1/2 \ge a^{\dagger}$, hence

$$\mathbb{E}[\pi_{\mathsf{farm}}] \le V(0.1\cdot 0.03 - 0.9 \cdot 0.03) - c_f = -0.024\,V - c_f \;<\; 0,$$

strictly, for every $V > 0$ and every $c_f \ge 0$. Across $\nu$ attacks per
epoch the epoch payoff is $\nu \cdot \mathbb{E}[\pi_{\mathsf{farm}}] < 0$,
decreasing in $\nu$: the optimum farming rate is **zero**. ∎

**Note on what farming *can* still buy.** Farming wins are the jury's errors,
not the farmer's skill; A4 caps them at $1 - a_f \le 0.1$. If a farmer
*selects* disputes where the jury is systematically weak (adversarial target
selection), that is not farming but evidence-quality arbitrage — it
challenges *merited* cases and is the mechanism working (the challenger
reward is exactly the price paid for surfacing them).

## 5. The flip region — the operator's tuning guard

Solving $\mathbb{E}[\pi_{\mathsf{farm}}] \ge 0$ for each parameter:

| Lever | Farming flips profitable when | Shipped value | Margin |
|---|---|---|---|
| jury accuracy on manufactured disputes | $a_f < \rho/(\rho+\beta)$ | $a^{\dagger} \le 0.5$; A4 gives $a_f \ge 0.9$ | ≥ 0.4 |
| challenger bond ratio $\beta$ (raise = safer) | $\beta < \rho(1-a_f)/a_f$ | 0.03 vs required $0.03\cdot\tfrac{0.1}{0.9} = 0.0033$ | **9×** |
| challenger reward share $\rho$ (raise = riskier) | $\rho > \beta\,a_f/(1-a_f)$ | $\rho \le 0.03$ vs allowed $0.03\cdot 9 = 0.27$ | ≥ 9× |
| dispute value $V$ | never — the bound is scale-free in $V$ | — | ∞ |

**Guard (proven form).** *Farming is EV-negative iff
$\beta \ge \rho (1-a_f)/a_f$; with the shipped symmetric bonds this holds
for all $a_f > \rho/(\rho+\beta) \le 0.5$.* The operator who retunes the
bond/reward schedule must keep this inequality — it is the exact condition,
not a heuristic. The 9× margin is the quantitative meaning of the spec's
"symmetry kills farming EV" (L214): at $a_f = 0.9$ the bond need only be
$0.37\times$ the reward for the theorem to hold; shipping $1\times$ buys
robustness down to coin-flip juries.

## 6. What is NOT proved here (honest edges)

- **LEMMA-GAP (measurement, not proof):** $a_f$ — jury accuracy on
  manufactured disputes — is an empirical quantity (A4 asserts $a^* = 0.9$
  as design target). The theorem's *form* is unconditional; its *application*
  is only as strong as the measured $a_f$. The Monte Carlo spec (README §4)
  includes the `challenge-farmer` strategy precisely to measure the EV sign
  against this boundary.
- **Multi-attack correlation:** if one farmer's attacks share evidence flaws
  that juries systematically miss (correlated errors, $a_f$ effectively lower
  on *that* subclass), the subclass boundary is
  $\rho_{\text{sub}}/(\rho_{\text{sub}}+\beta)$ for that subclass's reward —
  the guard applies per-subclass, and correlated-error monitoring
  (overturn-rate table, spec L253) is the mitigation.
- **Challenger-reward top-ups** (spec fatal-mistake (4): "never top up the
  fee pool") would break Lemma 1.1's closed-budget bound if ever shipped;
  the theorem flags the dependency explicitly.
