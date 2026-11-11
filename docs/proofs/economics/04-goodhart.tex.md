# Theorem 4 — Goodhart under the composite SLA: the farmer's optimum, the pass-mark condition, and the reset loop

**Binds to:** `courtSlaComposite.ts:24,59` (composite + FLOOR = 0.5, bao.markets),
pins `mechanismAdversarial.test.ts:347–362` (0.5 / 0.75 / 1.0 exactly),
`jurorReputationWeight.ts:38–62,292–335` (SLA-miss penalty ×0.8 with ack-rate
target 0.95, floor 0.5·$w_0$, idle expiry 6 epochs → $w_0$),
`SummonsAckService.ts:1093–1096` (ackRate = acked ÷ published),
paper §7.4 lines 593–627 (the two consumption obligations), findings R10b /
C-2 (`REVIEW_SIMULATION.md:443–467`), PO-12 (`THREAT_MODEL.md` §6 PO-12).
**Status:** proof complete; the R10/R16 holes are upgraded from TODOs to
**proven conditions** (Corollary 4.1 and Theorem 4.3), and PO-12's reset loop
is quantified (Theorem 4.4).

---

## 1. Setup

The retainer layer scores each juror per window on the shipped composite

$$S \;=\; \underbrace{\text{ackRate}}_{=\,a_r}\cdot\big(\tfrac12 + \tfrac12\,\underbrace{\text{participationRate}}_{=\,p_r}\big)
\;=\; a_r\Big(\tfrac12 + \tfrac12 p_r\Big), \qquad 0 \le a_r, p_r \le 1, \tag{4.1}$$

(`courtSlaComposite.ts:59`, FLOOR = 0.5 at `:24`), and the host pays the
retainer $R_{\mathsf{ret}}$ iff $S \ge \tau$ (the retainer/retention
threshold — a **host duty**; paper §7.4 obligation (i)). The reputation
layer (independent of $S$) penalizes **ack-rate** misses only:
$\times 0.8$ per epoch with ackRate $< 0.95$ and denominator ≥ 3
(`jurorReputationWeight.ts:60–62,292–296`); participation does not enter the
weight at all. A **farmer** runs an auto-ack agent: ackRate $= 1$ at zero
marginal cost, participation $p_r$ chosen, participation cost $c_p > 0$ per
summons (A8). Juror case fees are earned only through participation (seated
work), so a farmer at participation $p$ forgoes the fee flow proportionally.

## 2. Lemma — the cap is tight and the optimum is a corner

> **Lemma 4.1 (Farmer ceiling).** With $p_r = 0$: $S = a_r \cdot 0.5 \le 0.5$,
> with equality at $a_r = 1$ — the all-ack/zero-participation farmer scores
> **exactly 0.5**. (Pinned: `mechanismAdversarial.test.ts:352`,
> `expect(farm.composite).toBe(0.5)`.) For any $p_r$: $S \le a_r \le 1$, and
> $S$ is **linear, strictly increasing** in both $a_r$ and $p_r$ on
> $[0,1]^2$ — no curvature, no interaction, no memory across windows.

> **Lemma 4.2 (Corner solution / Goodhart clearing).** Fix ackRate $a_r = 1$
> (costless for the farmer) and a threshold $\tau \in (0, 1]$. The
> cheapest $S \ge \tau$ is achieved at
>
> $$p^{*} \;=\; \max\big(0,\; 2\tau - 1\big), \qquad S(p^{*}) = \max(\tau, 0.5),$$
>
> and **every unit of participation above $p^{*}$ is strictly wasted**
> (it buys nothing: $S$ has no bonus region, no dynamics, no second priced
> moment). If $\tau \le 0.5$, $p^{*} = 0$: the pure farmer clears the
> retainer with zero participation.

*Proof.* (4.1) with $a_r = 1$: $S = (1+p_r)/2$, so $S \ge \tau \iff p_r \ge
2\tau - 1$; clamp at 0. Linearity (Lemma 4.1) makes any $p_r > p^{*}$ payoff-
dominated (cost $c_p$ per unit, zero marginal reward). ∎

## 3. Theorem 4.3 — the farmer's optimum and the pass-mark condition

> **Theorem 4.3 (Optimal manipulation and the proven fix for the pass-mark
> hole).** The farmer's per-window optimization is
>
> $$\max_{0 \le p \le 1}\; \Big[ R_{\mathsf{ret}}\cdot\mathbb{1}\big[\tfrac{1+p}{2} \ge \tau\big] + p\,\bar F_{\mathsf{fees}} - c_p\,p\,T \Big]$$
>
> ($\bar F_{\mathsf{fees}}$ = expected case-fee flow at full participation,
> $T$ = summons volume per window). Its unique optimum is the corner
>
> $$p^{*} = \max\big(0,\, 2\tau - 1\big),$$
>
> and **farming strictly dominates honesty iff**
>
> $$c_p\,\big(1 - p^{*}\big)\,T \;>\; \bar F_{\mathsf{fees}}. \tag{4.2}$$
>
> The two R10/R16 conditions, now theorems:
>
> **(C4.1 — pass-mark corollary).** *The 0.5 floor is decorative exactly when
> $\tau \le 0.5$*: then $p^{*} = 0$, the farmer scores $S = 0.5 \ge \tau$,
> and collects the full retainer at zero participation. The cap binds **iff
> $\tau > 0.5$** — paper §7.4's obligation (i), proven.
>
> **(C4.2 — profitability guard).** *For $\tau > 0.5$, farming is
> non-profitable iff* $c_p (2 - 2\tau) T \le \bar F_{\mathsf{fees}}$, i.e.
> the participation the farmer must buy to clear $\tau$ costs at least the
> fee flow it forgoes:
>
> $$\tau \;\ge\; 1 - \frac{\bar F_{\mathsf{fees}}}{2\,c_p\,T}. \tag{4.3}$$
>
> Inequality (4.3) is the **operator's tuning guard** in proven form: it
> replaces the R10 TODO ("retainer threshold MUST be > 0.5") with the exact
> joint condition on $(\tau, R_{\mathsf{ret}}, c_p, T, \bar F)$.

*Proof.* The objective's indicator makes it a step function of $p$: below
$p^{*}$, retainer lost; at/above, retainer gained. For $\tau > 0.5$:
payoff at the corner $= R_{\mathsf{ret}} + p^{*}\bar F_{\mathsf{fees}} -
c_p p^{*} T$; honest full participation $= R_{\mathsf{ret}} +
\bar F_{\mathsf{fees}} - c_p T$. Farming dominates iff the difference is
positive:
$R + p^{*}\bar F - c_p p^{*} T > R + \bar F - c_p T \iff c_p(1 - p^{*})T >
\bar F(1 - p^{*})$; for $p^{*} < 1$ (i.e. $\tau < 1$) divide:
$c_p T > \bar F$ **scaled by the participation gap** — precisely (4.2)'s
form with $1 - p^{*} = 2(1 - \tau)$. For $\tau \le 0.5$, $p^{*} = 0$: the
farmer keeps $R_{\mathsf{ret}}$ and pays $c_p T \cdot 0$; farming dominates
iff $c_p T > \bar F$ unconditionally — the pass-mark regime is farming-
optimal whenever participation costs anything above the fee flow. ∎

**Numeric reading.** With the spec's steady state ($\bar F_{\mathsf{fees}}
\approx 500$ sats/day earned via seated work; $c_p$ the per-summons effort;
$T$ summons/epoch): the guard (4.3) requires the retainer threshold to sit
above $1 - \bar F/(2c_pT)$. E.g. if full participation costs
$c_p T = 2{,}000$ sats/epoch against $\bar F = 3{,}500$ sats/epoch of fee
flow, (4.3) is $\tau \ge 1 - 3500/4000 = 0.125$ — satisfied by any
$\tau > 0.5$; the binding regime is only when participation is *cheap
relative to fees* ($c_pT < 2\bar F$), i.e. exactly the auto-ack-agent
future the R10 audit targeted. **Design consequence:** the composite's
game-resistance is not a property of the composite alone but of the
$(\tau, c_pT/\bar F)$ pair — which is why paper §7.4 pins the threshold as a
deployment obligation rather than a protocol constant.

## 4. Theorem 4.4 — the idle-expiry reset loop, quantified (PO-12)

> **Theorem 4.4 (Reset-loop average weight).** The shipped weight function
> resets to $w_0$ once the record is > 6 idle epochs behind
> (`jurorReputationWeight.ts:255–259`), the earned record — penalties
> *included* — wiped. Two farmer regimes, kept separate because they fare
> differently:
>
> - **Pure ack-farmer** (ackRate $= 1$): never trips the SLA-miss penalty
>   (ack target 0.95, `:60`), so expiry is a **no-op** for it ($w_0 \to w_0$);
>   its binding constraint is the composite's 0.5 retainer ceiling
>   (Corollary C4.1), not the weight. The reset loop is worth it **nothing**
>   here — stated to preempt an overclaim.
> - **Penalized farmer** (SLA-miss or escalation penalties — e.g. a
>   cheap-ack farmer at ackRate $< 0.95$): penalties compound
>   $\times 0.8$ per miss-epoch to the floor $0.5 w_0$
>   ($0.8, 0.64, 0.512, 0.5$ — floored from $k = 4$ since
>   $0.8^4 = 0.4096$; pinned at `mechanismAdversarial.test.ts:541–545` for
>   the alternating case: 3 miss-epochs → $0.8^3 = 0.512$, unfloored). Its
>   optimal reset cycle is:
>   **farm 6 epochs** (weight path $0.8, 0.64, 0.512, 0.5, 0.5, 0.5\,w_0$),
>   **idle 6 epochs** (weight holds at the last computed $0.5\,w_0$ — the
>   record still exists, idle $\le 6$),
>   **epoch 13: expiry fires** (idle $> 6$) → weight restored to $w_0$;
>   return and repeat. Long-run average weight under the cycle:
>
> $$\bar w_{\mathsf{cycle}} \;=\; \frac{(0.8 + 0.64 + 0.512 + 0.5 + 0.5 + 0.5) + 6 \times 0.5 + 1}{13}\,w_0 \;=\; \frac{7.452}{13}\,w_0 \;\approx\; 0.573\,w_0 .$$
>
> Under the **documented fix** (expiry preserves the penalized record —
> decay instead of reset; `THREAT_MODEL.md` §6 PO-12 closure column), the same
> farmer's long-run weight converges to the floor, $0.5\,w_0$: the reset
> loop is worth **+14.6% of sustained selection weight to a penalized,
> non-participating farmer** — the loop launders penalty history exactly as
> R10b flagged, and Theorem 3's Remark 3.3(ii) shows it also weakens
> collusion deterrence. PO-12's "documented design fix" is thus quantified:
> the fix's value is the 0.573 → 0.500 gap, and the pure ack-farmer's cap
> lives in the composite (C4.1), not here.

*Proof.* The cycle arithmetic is direct from the shipped evaluation order
(`jurorReputationWeight.ts:200–226` docstring; penalty floor `:332–335`;
expiry branch `:255–259` returns $w_0$ unconditionally — the *entire*
computed weight including penalties is discarded). Long-run average weight =
cycle average by renewal-reward (the cycle is i.i.d. across periods). ∎

> **Remark 4.5 (the coherence residual — named, not closed).** Following
> C-2(iii): the composite prices **attendance, not coherence** — a juror
> acking and voting in everything but voting wrong keeps $S = 1.0$; wrongness
> is priced only by the slashing layer when an overturn materializes
> (Theorem 1's $\alpha_I$, Theorem 3's flip exposure). The composite's
> equilibrium analysis is therefore complete *given* the slashing layer's
> pricing; the residual "wrong-but-attentive" juror is profitable exactly
> while its overturn rate stays under the spec's 20% demotion threshold
> (L253) — a measurable band, monitored, not eliminated. This is RS-9
> (`REVIEW_SIMULATION.md:466–467`), here given its quantitative boundary:
> the wrong-but-attentive strategy's EV is $O_j$-bounded, and the $O_j$
> monitor is what converts Goodhart on $S$ into eventual slashing exposure.

> **Remark 4.6 (why the floor does not kill the fix).** The floor
> $0.5\,w_0$ is shared by honest bad-luck jurors and penalized farmers
> alike; the fix (decay-not-reset) does not touch the floor — it removes
> only the *restoration to $w_0$*. Honest jurors who keep participating
> rebuild via the contribution bonus (bounded by Lemma 1.3 of 01); farmers
> who do not participate have no bonus term — the fix separates the two
> populations on the only axis that differs, participation. ∎

> **Remark 4.7 (the R23 decay ramp — 06 r30-4).** The idle-expiry reset costed
> in Theorem 4.4 has since been replaced in code by **continuous decay**,
> $w = w_0 + (w_{\text{earned}}-w_0)e^{-\lambda\,\text{idle}}$ with
> $\lambda = \ln 2/3$. That removes the *cliff* (no single epoch restores $w_0$)
> but not the *loop*: a penalised juror's weight is **non-decreasing in
> idleness** ($0.500 \to 0.603 \to 0.750$ over 1/2/3 idle epochs from the floor),
> and the decay's average weight exceeds the cliff's at **every finite cycle
> length** — +26.0 % at 6 active/6 idle, +44.5 % at 1/6, +12.6 % at 1/12 —
> while converging to the same endpoint $w_0$. So T4.4's 0.573·$w_0$ figure is a
> pre-R23 baseline, and the loop it prices is *cheaper* under the fix, not
> removed: the cliff's only cost to the farmer was the six-epoch wait. The
> repair is an **anchored** decay (`anchor = earned ≥ w0 ? w0 : 0.5w0`, so a
> penalty decays toward the floor instead of toward probation), paired with
> penalty ageing so that participation — not idleness — is the recovery path.
> Full derivation: [`06-expert-verify.tex.md`](06-expert-verify.tex.md) §4.
> C4.1, C4.2 and the retainer optimum $p^{*} = \max(0,2\tau-1)$ are **unaffected**
> — the composite has no memory, so no value of $\lambda$ changes them.

## 5. What is NOT proved here

- **LEMMA-GAP (empirical $c_p$, $\bar F$):** (4.2)/(4.3) contain effort and
  fee-flow quantities that are deployment measurements, not constants; the
  theorem's *form* is unconditional, the guard's *margin* is not. The
  Monte Carlo's `coherent-farmer` and `idler` strategies (README §4) exist
  to measure exactly these.
- **The retainer's size $R_{\mathsf{ret}}$ drops out** of the *dominance*
  comparison (both strategies collect it when above $\tau$) but not of the
  farmer's absolute profitability — a retainer below the clearing cost
  makes even successful farming pointless; that is a level choice, not an
  incentive-compatibility one, and is deliberately not "fixed" here.
- **T4.4's cycle assumes the farmer can hold the idle gap** (no summons
  worth taking for 6 epochs); with summons flow high enough, idling is not
  choosable and the loop's value shrinks toward zero — deployment-dependent,
  measured by the `idler` Monte Carlo strategy.
