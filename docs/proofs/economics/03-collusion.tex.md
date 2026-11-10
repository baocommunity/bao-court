# Theorem 3 — Majority-collusion: the PO-1 discharge, condition-bounded

**Binds to:** threshold quorum (round 0: 3 of 5, `confirmationMachineTypes.ts`
round-0 semantics; paper §6.1), unpredictable selection (`selection.ts:163–229`,
A5), escrow slashing (`escrow.ts:93–96,133–155`), clawback flags
(paper §6.3, `applyRoundClawbacks`), closed-budget ledger
(`JurorPoolLedger.ts:39–62`), retention monitors (spec L191, L253–254),
escalation ladder (Theorem 2).
**Status:** Theorem 3.1 proved (resistance region, closed form); Theorem 3.2
proved (the amortized-cartel limit is NOT covered — stated, not hidden).
**PO-1 verdict: CONDITION-BOUNDED** — the honest outcome the task anticipated.
This file upgrades `THREAT_MODEL.md` §6 PO-1 from "equilibrium unmodeled" to a
precise resistance condition with a numeric region; it does **not** claim an
unconditional discharge.

---

## 1. The bribe game

A **briber** wants the verdict on a dispute of value $V$ to be $\ne$ the true
outcome. The seated threshold is $t_0 = 3$ of $n_0 = 5$ (round 0) and a
majority of $n_r$ at ladder round $r$. The briber writes **contingent
contracts** with pool members: *if seated and you vote as directed, you are
paid $b$*. Payment is delivery-contingent, so:

- pool members who are never seated cost the briber only the **coordination
  overhead** $\kappa_0$ each (contracting across pseudonymous keys —
  communication, escrowed promise enforcement, identity vetting);
- the briber needs enough contracted members that the **seated set contains
  a bribable threshold w.h.p.** — by selection unpredictability (A5) the
  seated set is a draw from the pool, so contracting the *active-juror set*
  (the jurors with meaningful selection weight, $A \approx 50$ at the spec's
  steady state, spec L223) or a fraction $q^*$ of the full pool.

A contracted juror $j$ accepts iff (individual rationality):

$$b \;\ge\; \underbrace{p_{\mathsf{flip}}\big(\alpha_I s + \lambda_W W\big)}_{\text{slashing + clawback exposure when the verdict is later flipped}}
\;+\; \underbrace{\delta\, p_{\mathsf{eject}}\, L_{\mathsf{stream}}}_{\text{discounted future income lost on ejection (A1, A7)}} \tag{IR}$$

where $s$ is the juror stake ($\max(0.02 V_m, 5000)$, `escrow.ts:147`),
$\alpha_I = 1/2$ the incoherent slash (`escrow.ts:93`), $\lambda_W W$ the
clawback's reputation value (flags `overturned_confirmation` / `round_flip`,
paper §6.3 — priced via the weight formula §5.4 of the model), and
$L_{\mathsf{stream}} = J/(1-\delta)$ the discounted per-epoch juror
income $J$ lost when the retention table ejects
(2 consecutive SLA-miss epochs ⇒ ejection, spec L191; overturn-rate
$O_j > 20/35/50\%$ ⇒ demote / cooldown / 100% standing-bond slash, spec
L253–254 — A7 makes $p_{\mathsf{eject}}$ a *mechanical* consequence of
sustained wrong voting, not a discretionary one).

**The endogenous flip probability.** A bribed verdict at round $r$ survives
only if every subsequent honest escalation also lands the briber's way. By
Theorem 2, a merited loser escalates while $r \le r^*$ — so the briber must
**re-buy every round up to $\min(\text{cap},\, r^*_{\mathsf{honest}})$**:

$$p_{\mathsf{flip},r} \;=\; 1 - (1-a)^{\,R - r}, \qquad R = \min\big(\text{cap},\, r^*_{\mathsf{honest}}\big),$$

with $a$ the jury accuracy (A4) and cap = 2 shipped
(`courtConfirmationMachine.ts:242–247`). **The escalation ladder is the
collusion price**: each rational honest escalation multiplies the briber's
required payment mass by the next round's panel.

## 2. Theorem 3.1 — the resistance condition and $\kappa^*$

> **Theorem 3.1 (Per-attack bribery resistance, condition-bounded).** Under
> A1–A8, a briber attacking one dispute of value $V$ with coordination cost
> $\kappa_0$ per contracted member has per-attack cost
>
> $$C(V, \kappa_0) \;=\; \kappa_0\, m \;+\; \sum_{r=0}^{R} n_r\, q\; b_r,
> \qquad b_r \;=\; p_{\mathsf{flip},r}\big(\alpha_I s + \delta p_{\mathsf{eject}} L_{\mathsf{stream}}\big),$$
>
> ($q$ = expected fraction of the seated panel that is contracted; $q \to 1$
> for an active-set cartel, $q \approx q^* \approx 0.82$ for a pool-wide
> hypergeometric contract at 95% coverage). The attack is EV-negative —
> the mechanism resists — **iff**
>
> $$V \;<\; C(V,\kappa_0), \qquad\text{i.e.}\qquad
> \boxed{\;\kappa \;\ge\; \kappa^{*}(V) \;=\; V - C_{\mathsf{pay}}(V)\;}$$
>
> with $C_{\mathsf{pay}} = \sum_r n_r q\, b_r$ the payment mass. The
> **zero-coordination resistance region** $V \le V^{*}$ (where
> $\kappa^* \le 0$, the bribe arithmetic alone deters) is
>
> $$V^{*} \;=\; \frac{\sum_{r=0}^{R} n_r\,q\; p_{\mathsf{flip},r}\;\delta\,p_{\mathsf{eject}}\,L_{\mathsf{stream}}}
> {1 - \sum_{r=0}^{R} n_r\,q\; p_{\mathsf{flip},r}\;\alpha_I \cdot 0.02}.$$

*Proof.* The briber's gain is $V$ (it takes the disputed value); its bonds
are returned when it wins every round, so the net gain is
$V - C(V,\kappa_0)$. Individual rationality (IR) pins each delivered bribe at
$b_r$: below it, the juror's honest strategy (vote truth, collect
$\bar f_d + \text{coherent share}$, keep the stream) strictly dominates —
the fee is paid for participation either way (closed budget, A6), so the
bribe only needs to cover the *differential* exposure, which is exactly the
flipped-verdict slash + clawback + ejection stream. Summing delivered bribes
over the rounds the briber must win ($R$ from Theorem 2's endogenous
escalation) gives $C_{\mathsf{pay}}$. Solving $V < C_{\mathsf{pay}}(V) +
\kappa_0 m$ for the stated boxed condition; the $V^{*}$ form is the same
inequality at $\kappa_0 = 0$ with the $V$-dependent and $V$-independent
parts of $b_r$ separated ($s = 0.02 V_m \approx 0.02V$). ∎

### Numeric region (shipped/spec parameters)

Parameters: $a = 0.9$ (A4), cap = 2, $s = 0.02V$, $\alpha_I = 0.5$,
$\delta = 0.95$ (A1), $J = 3{,}500$ sats/epoch ($\approx$ 500 sats/day, spec
steady state L223), $p_{\mathsf{eject}} = 0.5$, $q = 1$ (active-set cartel —
the *strongest* briber; weaker coverage only raises cost), so
$\delta p_{\mathsf{eject}} L_{\mathsf{stream}} = 0.95 \cdot 0.5 \cdot 3500 \cdot 20 \approx 33{,}250$ sats.
The clawback's reputation value $\lambda_W W$ (IR) is **consolidated into the
stream term** for the numerics: the weight's cash value *is* future selection
income, so counting both would double-charge; the stated numbers are
therefore conservative against resistance. Per-round flip probabilities
(endogenous, from Theorem 2): the round-$r$ bribe must survive the
$R - r$ remaining honest escalations, $p_{\mathsf{flip},r} = 1-(1-a)^{R-r}$;
**the last bribed round carries no flip risk** ($p_{\mathsf{flip},R} = 0$) —
it is bought at coordination cost only.

| Victim's confidence (drives $R$ via Thm 2) | $R$ | effective bribed mass $\sum n_r p_{\mathsf{flip},r}$ | $C_{\mathsf{pay}}(V)$ | $V^{*}$ ($\kappa = 0$) |
|---|---|---|---|---|
| $p_0 < 8.3\%$ (won't rationally escalate) | 0 | 0 | $\approx 0$ (bribes $\to \varepsilon$) | **$\approx 0$ — $\kappa$-bounded only** |
| $8.3\% \le p_0 < 95.6\%$ | 1 | $5 \cdot 0.9 = 4.5$ | $0.045V + 149.6\text{k}$ | **157k sats** |
| $p_0 \ge 95.6\%$ (full cap-2 ladder) | 2 | $5\cdot0.99 + 15\cdot0.9 + 45\cdot0 = 18.45$ | $0.1845V + 613.5\text{k}$ | **752k sats** |

**Readings.**

- **The zero-κ resistance region is powered by the victim.** The escalation
  ladder multiplies the bribed mass only when the honest counterparty
  rationally escalates (Theorem 2): a confident victim ($p_0 \ge 95.6\%$)
  drags the briber through all shipped rounds and lifts $V^{*}$ to
  $\approx 752$k sats — **discharging PO-1 with $\kappa = 0$ for the
  deployed demo/testnet stakes** ($\lesssim 10^6$ sats, middle and bottom
  rows). A victim who rationally concedes (top row) leaves the verdict
  defended only by coordination costs — see the honest remark below.
- **For large $V$, resistance is assumption-bounded:** beyond $V^{*}$ the
  mechanism resists iff $\kappa \ge \kappa^{*}(V) = 0.8155\,V - 613.5\text{k}$
  (worst case, $R=2$): the coordination cost of contracting a collusive set
  must exceed $\approx 82\%$ of the disputed value asymptotically. Whether
  real-world $\kappa_0$ (pseudonymous contracting, no legal enforcement,
  betrayal options) meets that is an **empirical** question — the paper's
  residual honesty, now with a number on it.
- **Weak-victim honesty (top row).** When no standing party rationally
  contests the verdict, round-0 bribery costs coordination only — but such
  a verdict is also one the victim *agrees* is probably right: the residual
  is the oracle-quality question (paper §8.4's Schelling reading), not
  bribery; it is self-hiding precisely because nobody with standing
  disagrees. Stated, not closed.

### 2.1 Per-rail addendum — where condition (IR) has teeth (05 §2–§3)

Theorem 3.1's (IR) floor assumes the colluder's own capital is at risk. That is
a *rail* property, not a protocol one, and it is the one gap the review round
demanded be closed explicitly — now done in
[`05-review-gapfills.tex.md`](05-review-gapfills.tex.md):

| Rail | Seizure | $\alpha$ | Does (IR) bite? | $V_{\max}$ |
|---|---|---|---|---|
| Liquid P2WSH/Taproot escrow (Panel B, `liquidEscrow.ts:6`, `liquidRail.ts:37` `multisig_slash`) | on-chain script branch, objective | 0.5 / 1 | **yes** | (5.3): 1.425M sats at $N{=}45$; **unbounded at $t \ge 1/(\alpha\sigma) = 100$ seats** |
| Lightning hold-invoice (Panel A, `lnSettlement.ts:3–10` — "denial of reward + reputation, *social slashing*") | none — a cancelled hold returns the payer's money | **0** | **no** | stream term only (997.5k sats at $N{=}45$) — reputational, exit-evadable |
| Phase-0 zero-stake (`weightFn`) | none | **0** | **no** | stream term only |

Two consequences for this theorem, both stated in 05 and neither hidden here:
**(a)** the shipped round-2 panel *fails* Gemini's market-cap invariant
$V \le \gamma\sum_i S_i$ (0.45·$V$ at $N{=}45$; 1.35·$V$ at $N{=}135$), so
above $N{=}45$ the theorem's resistance is carried by the stream term — the one
a hit-and-run cartel (Theorem 3.2) does not hold; **(b)** the P+ε variant of the
bribe (05 Theorem 5.2) prices an *outcome*-contingent slash at
$\max(0,1-2\pi)$ of its face value — exactly zero for a cartel that is already
likely to win — so the shipped $\alpha_I$ is P+ε-neutral and the resistance in
the tables above is supplied by the ladder (making $\pi$ tiny) and by $\kappa_0$,
not by the slash. Closing (b) needs an **act-contingent** forfeit
$t\,D \ge V - \kappa_0 m$, which no shipped artefact provides (05 GAP-5e).

## 3. Theorem 3.2 — the amortized-cartel limit (honest non-discharge)

> **Theorem 3.2 (Amortized cartels escape the coordination term).** A cartel
> that forms ONCE and attacks $A$ disputes amortizes coordination:
> $\kappa_{\mathsf{eff}} = \kappa_0 m / A \to 0$ as $A \to \infty$. Per-attack
> resistance then requires $V \le C_{\mathsf{pay}}(V)$ alone, i.e.
> $V \le V^{*}_{\mathsf{pay}}$ with the stream term *retained* — the stream
> term is per-attack and un-amortizable **only under A7's eventual-detection
> reading**: a cartel flipping verdicts at rate $\nu$ drives each member's
> overturn rate $O_j$ past the spec's 20% demotion threshold within
> $O(1/\nu)$ epochs, so $p_{\mathsf{eject}} \to 1$ over the cartel's lifetime
> and the (IR) bribe floor rises to the full stream value for *sustained*
> cartels. For a hit-and-run cartel ($A$ large, then disband before
> detection), the stream term is evaded and resistance requires
> $\alpha_I s$ alone: $V^{*}_{\mathsf{hit\text{-}run}}$ is the same formula
> with the stream term deleted — **$\approx 0$ for every $V$ with
> $0.030V \cdot(\ldots) < V$, i.e. NOT resistant.**

*Proof.* Immediate from Theorem 3.1 with $\kappa_0 m/A \to 0$ and
$p_{\mathsf{eject}} \to 0$ when the cartel disbands before the retention
monitors' epoch-scale detection window (A7 gives $p_{\det} \to 1$ *per
epoch scale*; a sub-epoch campaign finishes first). ∎

> **Remark 3.3 (what bounds the hit-and-run cartel in practice).** (i) The
> **floor asymmetry**: the shipped penalty floor $0.5\,w_0$
> (`jurorReputationWeight.ts:50,332–335`) protects honest jurors from death
> spirals but equally caps a colluder's downside — the *reputation* channel
> alone can never deter (this is why Theorem 3.1's teeth are ejection +
> slashing, not weight decay). (ii) **PO-12's idle-expiry reset**
> (`jurorReputationWeight.ts:255–259`) restores $w_0$ after 6 idle epochs —
> the reset loop that farms SLA also *launders* a colluder's penalty history;
> Theorem 4 (§04) quantifies the same loop for farmers. (iii) **Bond
> escrow-before-validity + the 1%-of-volume eligibility gate**
> (`selection.ts:275`) price Sybil identities: a hit-and-run cartel must
> still post real stakes $s = 0.02V$ per seated colluder, forfeited at
> $\alpha_I = 1/2$ on any flip it fails to survive — the hit-and-run cartel
> is resistant-to-resistance exactly to the extent it avoids escalation,
> which Theorem 2 makes expensive in $V$. None of these closes Theorem
> 3.2's hole; they bound its profitability. Stated honestly: **against
> sub-epoch-detection-scale hit-and-run cartels on high-value disputes, the
> shipped mechanism's resistance is an open region**, and the closure paths
> are the threat model's own: raise $t$/jury size per market value
> (`THREAT_MODEL.md` §6 PO-1, closure column) and per-market value gating
> (spec L118–119's bond ≥ 25% for $r \ge 3$).

## 4. PO-1 status, precisely

| Regime | Status |
|---|---|
| Demo/testnet stakes ($V \lesssim 10^6$ sats), contested verdicts | **Discharged with $\kappa = 0$** (Thm 3.1: $V^{*} \approx 157$k–752k sats by victim confidence; bottom row covers typical disputes) |
| Weakly-contested verdicts (no standing escalator) | **$\kappa$-bounded only** ($V^{*} \approx 0$) — self-hiding residual, see the honest remark. **Now quantified:** at the spec's 3-of-5 round-0 quorum the capture probability is 0.2099 at $\rho = 1/3$ and 0.4813 at $\rho = 0.49$ (05 §1.3, Finding 1.1) — and 0.8683 / 0.9655 if the host leaves `confirmQuorum` at its code default of 1 |
| High-value disputes, one-off bribery | **Condition-bounded**: resistant iff $\kappa \ge 0.8155\,V - 613.5\text{k}$ (worst case). Per-rail form in 05 §2: on the Lightning rail the $\alpha s$ term is absent, so only the stream term remains |
| High-value disputes, amortized/hit-and-run cartel | **Open region** (Thm 3.2) — mitigations bounded, not closed (Remark 3.3) |
| P+ε / losing-branch-only bribe contract | **Open on any rail whose only sanction is outcome-contingent** (05 Theorem 5.2): the cheapest accepted contract costs $\max(0,1-2\pi)X$ — free for a cartel with $\pi \ge \tfrac12$; on the Lightning rail free at every value above the fee mass (Cor. 5.3) |

`THREAT_MODEL.md` PO-1 should be read as upgraded to: *"bribery-resistant
iff $V \le V^{*}(\delta, J, a, \text{cap})$ or $\kappa \ge \kappa^{*}(V)$;
hit-and-run cartels on $V > V^{*}_{\mathsf{pay}}$ remain an open economic
region"* — with $V^{*}$ numeric above. That conditional statement, with its
assumptions numbered and its open region named, is the publishable form
(mechanism-design practice: state the resistance condition; the condition's
empirical side is the measurement program, README §4).

## 5. What is NOT proved here

- **LEMMA-GAP (A7's timescale):** "$p_{\det} \to 1$ at epoch scale" is a
  monitor-tuning claim (thresholds 20/35/50% exist in spec L253–254; their
  statistical power against a $\nu$-rate cartel is unanalyzed). The theorems
  are stated *in* $p_{\mathsf{eject}}$; the numbers use 0.5.
- **LEMMA-GAP (A4 independence across rounds)** — inherited from Theorem 2;
  correlated jury errors lower $p_{\mathsf{flip}}$, shrinking $V^{*}$
  proportionally (the formulas are linear in $p_{\mathsf{flip}}$).
- **Identity economics:** Sybil provisioning cost (WoT 80, age ≥ 7d,
  1%-volume gate, confirmed stake commitments — `selection.ts:81–87,263–286`)
  enters $\kappa_0$ but is not priced here; it is the natural next term to
  measure.
