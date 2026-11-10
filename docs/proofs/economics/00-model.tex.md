# The Economic Game — Formal Model

**Round 19 of the symposium program (game-theoretic formalization).** This
file defines THE GAME whose equilibria theorems 01–04 analyse. Every
parameter is cited to the shipped code or the shipped specification, with
repo + file:line; where a value lives in a merged design document rather
than in TypeScript, it is marked **spec-pinned** (the distinction is kept
honest throughout — see §7). Sibling files: [`01-farming.tex.md`](01-farming.tex.md),
[`02-ladder.tex.md`](02-ladder.tex.md), [`03-collusion.tex.md`](03-collusion.tex.md),
[`04-goodhart.tex.md`](04-goodhart.tex.md),
[`05-review-gapfills.tex.md`](05-review-gapfills.tex.md) (the review-response
round: capture probabilities, per-rail cost of corruption, P+ε, seed grinding,
the √stake splitting result). The parallel mechanization branch
(`proofs/mechanized`, this round's companion track) machine-checks the
protocol theorems as `docs/proofs/mechanized/`; the economics theorems here
are analytic and bind to the same code lines.

---

## 1. Players

| Symbol | Player | Shipped identity |
|---|---|---|
| $P$ | **Proposer** — the verifier oracle that proposes every outcome (+ evidence bundle + proposer bond) | `docs/proposals/UNIVERSAL_JURY_CONFIRMATION.md` (bao.markets `origin/main`) line 16, role table line 35 |
| $X$ | **Challenger** — disputes a proposed/confirmed outcome by posting a bond | universal-confirmation dispute path, paper §6.1–6.2 (`docs/FROST_COURT_ORACLE_PAPER.md:437–470`) |
| $i \in \mathcal{N}$ | **Jurors** — pool of $N$ eligible accounts; $n_r$ seated per round | deterministic exponential-clock draw, `selection.ts` (`selectJury`, lines 368–379, bao-court) |
| $H$ | **Venue/host** — runs selection, escrow verification, the ledger, and the sweeps; *not a strategic player* in this model (its policy obligations are pinned elsewhere: paper §7.4, `THREAT_MODEL.md` §5) | `JurorPoolLedger.ts`, `SummonsAckService.ts` (bao.markets) |

$H$ non-strategic is assumption **A9** (§6): the host is the operator, its
misbehaviour is an operational/trust problem (`THREAT_MODEL.md` §5 boundary
table), not an incentive-design problem.

## 2. Types

- **Challenger type** $\theta_X \in \{\mathsf{merited}, \mathsf{unmerited}\}$:
  merited = the claimed outcome is consistent with the true outcome of the
  disputed event; unmerited = not (frivolous challenge, challenge-farming,
  griefing).
- **Juror type** $\theta_i \in \{\mathsf{honest}, \mathsf{farmer},
  \mathsf{colluder}\}$: honest = votes the true outcome when seated;
  farmer = optimizes the published SLA/weight metrics (auto-ack, minimal
  participation); colluder = votes as directed by a bribe contract when the
  bribe clears its participation constraint.
- **Dispute value** $V$ drawn from $F$ (assumption **A2**). Market volume
  $V_m \ge V$.
- Types are private; actions are **public** (commit–reveal with public
  commits, public acks kind 39008, public participation kinds 39015/39014,
  append-only public outcome history — paper §6.3, `SummonsAckService.ts:18`).

## 3. Action sets, per phase

| Phase | Player | Actions | Enforcement |
|---|---|---|---|
| propose | $P$ | propose $(o, \text{evidence})$; bond escrowed **before** validity | spec L197, L226 fatal-mistake (1); `BaoCourtService.ts:340–373` (bond computed + lock proof attached, bao.markets) |
| confirm (round 0) | seated $i$, $n_0 = 5$, quorum 3 | confirm / abstain | paper §6.1; `confirmationMachineTypes.ts:141–172` (bao-court). **Honest parameter note (05 §1.3):** the quorum is caller-supplied and the *code* default is **1** (`courtConfirmationMachine.ts:223`, `params.confirmQuorum ?? 1`); the spec's 3-of-5 is a host duty, and at 3-of-5 the capture probability is 0.21 at $\rho = 1/3$ versus 0.045 at the $\lceil 2N/3\rceil$ the threat model names |
| ack (any summons) | any $i \in \mathcal{N}$ | ack / not (kind 39008) | `SummonsAckService.ts` (bao.markets) |
| challenge | $X$ | challenge (bond-witnessed) / not | INV-CONF-17 bond witness; `escrow.ts:114–131` (`calculateBondAmount`) |
| vote (ladder round $r$) | seated $i$, $n_r = 5\cdot 3^r$ | commit → reveal / abstain | paper §6.2; `courtVoteMachine.ts` commit–reveal |
| escalate / concede | losing side via $H$ (host-driven, never auto) | escalate (post next round's bond) / concede | `courtConfirmationMachine.ts:79–81, 242–247` — `maxLadderRounds` default 2, bounded 1..5 |
| skip rounds | $X$ | post cumulative bond $\text{bond}_N = \text{base} + \sum_{r \le N} \text{fees}$ | spec L120–121 |
| audit (host policy) | $H$ | spot audits (divergence → $\times 0.8$) | `jurorReputationWeight.ts:44,306–307` |

## 4. Information structure

1. **Outcome proposal** public at $t_0$; challenger bond **escrowed before
   the challenge is valid** (spec fatal-mistake (1), L226; ledger lock path
   `pending ──lock(proofOk)──▶ locked`, paper §8.2 line 651).
2. **Commit phase**: votes hidden (salted commit); the commit *set* is
   public — a juror's participation is observable **before** reveals
   (kind 39015/39014), which is exactly what the SLA composite's
   participation term counts (`courtSlaComposite.ts:33–35`).
3. **Reveal phase**: all reveals public; tally is a pure function of the
   reveal multiset (Theorem 3, `docs/proofs/03-tally.tex.md`).
4. **Outcome history** append-only and public — every round's winner and
   winner indices (paper §6.3) — so each juror's overturn exposure
   $O_j$ (fraction of rounds they sat that were later overturned) is
   **publicly computable**; the spec's retention table publishes the
   demotion thresholds $O_j > 20/35/50\%$ (spec L253).
5. **Selection** is deterministic given
   $(\text{disputeEventId}, \text{blockHash}, \text{reputationRoot})$ but
   unpredictable ex ante (A5): no one knows the seated set when bribe
   contracts would have to be written. Residual seed-grinding is PO-2
   (`THREAT_MODEL.md` §6 PO-2), accepted and priced there — and quantified in
   [`05-review-gapfills.tex.md`](05-review-gapfills.tex.md) §4: the
   block-withholding re-draw is viable only above
   $V > R_{\text{blk}}/\Pr[X = t-1]$, i.e. $\ge 2.2\cdot10^{10}$ sats
   ($\approx 223$ BTC) in the most attacker-favourable shipped configuration.

## 5. Payoff functions — reconstructed from the shipped code

All amounts integer sats. $V$ = disputed value; $V_m$ = market volume.

### 5.1 Fees (the closed budget)

| Symbol | Value | Source |
|---|---|---|
| $f_u$ | uncontested fee ≈ $0.002 \cdot V_m$ **total**, split across the round-0 panel ($n_0{=}5$), floor 25 sats/juror → per juror $\bar f_u = 0.0004\,V_m$, floored | spec L210 (table row "Uncontested fee") |
| $k$ | disputed premium $= 7$ (band 6–8×) per juror vs uncontested | spec L211 |
| $\ell$ | disputed funding = **loser's bond, 2% flat of volume** — the disputed fee mass is $\ell = 0.02 V_m$, per juror $\bar f_d = 0.004 V_m$ | spec L212 |
| $\beta$ | proposer bond $B_p$ = **3%** of disputed payout value, escrowed pre-validity | spec L213; escrow-before-validity fatal-mistake L226 |
| $\beta$ | challenger bond $B_c$ = **symmetric 3%**, floor $\ge 2\times$ max juror fee/market | spec L214 |
| — | fee carve into the juror pool: `jurorPoolBps` of `baoFeeSats`, default-off (0), integer-bounded [0, 10000], fail-closed | `feeCalculator.ts:219–235` (`withJurorPoolCarve`), `courtFeatureFlags.ts:50,106,126` (bao.markets) |
| — | closed-budget ledger: inflows = `fee_accrual` + `bond_forfeit` + `case_credit`; outflows = `case_debit` + `retainer` + `dust_sweep`; **never negative** (`JUROR_POOL_BUDGET_EXCEEDED`), append-only, idempotent, parity-checked | `JurorPoolLedger.ts:39–62` (entry types + signs), `:229–233` (budget guard) |

**Closed-budget lemma (L-0).** Every sat any juror earns from a disputed
case enters the pool as a prior inflow (`fee_accrual` from the platform
share, `bond_forfeit` from a losing bond, `case_credit` from a clawback);
there is no minting. Hence the sum of all juror payoffs per case is bounded
above by $\ell + \beta + \text{carve}$, and any strategy that increases one
juror's share strictly dilutes the cohort's residual shares. (Direct from
`JurorPoolLedger.ts` header invariants + `verifyEpochParity()`.)

### 5.2 Escrow slashing (the stick)

Per-juror stake $s$; slash fractions $\alpha_I = 1/2$ (incoherent),
$\alpha_N = \alpha_D = 1$ (non-reveal, double-vote)
(`escrow.ts:93–96`, bao-court). Slashed pool

$$P \;=\; \sum_{j \in I}\big(s - \lfloor s/2\rfloor\big) + \sum_{j \in N\cup D} s \;+\; B\cdot\mathbb{1}[\text{dispute rejected}],$$

each coherent juror receives $s + \lfloor P/|C|\rfloor$; conservation checked
by `verifyRedistributionIntegrity` (paper §8.3, lines 660–675; `escrow.ts`
slashing plan). Shipped stake schedule: $s = \max(0.02 V_m, 5000)$, doubling
per appeal round (`escrow.ts:133–155`, `calculateJurorStake`); bond
$= \max(0.05 V_m, 10{,}000)$ doubling per round (`escrow.ts:114–131`) — the
**protocol-pinned** schedule; the v2 spec's symmetric 3%/2% schedule
(spec L212–214) is **spec-pinned** and supersedes it at the host layer (§7).

### 5.3 Ladder costs (the escalation price curve)

Round panels $n_r = 5 \cdot 3^r$ ($15, 45, 135, 405, \approx 1215$);
cumulative challenge cost if lost

$$c_r \;=\; \sum_{j=1}^{r} 3^j \;=\; \frac{3^{r+1}-1}{2}
\quad\Longrightarrow\quad c_1..c_5 = 4,\,13,\,40,\,121,\,364 \;\;\text{(× base)},$$

incremental cost of round $r$: $\Delta c_r = 3^r$. Source: spec §4.2 ladder
table, L108–117 (values 4×/13×/40×/121×/364× verbatim); machine side:
`confirmationMachineTypes.ts:160` + `courtConfirmationMachine.ts:242–247`
(`maxLadderRounds` default **2**, bounded 1..5), escalation host-driven and
exactly-once (INV-CONF-29). Deeper rungs gated by
bond ≥ 25% of disputed value for $r \ge 3$ (spec L118–119).

### 5.4 Reputation weight (the compounding asset)

Shipped pure core `jurorReputationWeight.ts` (bao.markets), parameters
verbatim at lines 38–62 (`REPUTATION_WEIGHT_PARAMS`):

$$w \;=\; w_0 \cdot g \cdot \Big(\prod_e \pen_e\Big) \cdot \Big(1 + \lambda \textstyle\sum_e c_e \cdot 0.9^{\text{age}_e}\Big)$$

| Parameter | Value | Line |
|---|---|---|
| $w_0$ (base/probation weight) | 1 | :38 |
| $\lambda$ (contribution bonus) | 0.15 | :40 |
| coherence gate $g$ | score < 0.6 ⇒ $w=0$; unscored ⇒ 1 | :42, :262–276 |
| SLA-miss penalty | $\times 0.8$ when published ≥ 3 and ackRate < 0.95 | :46, :60, :62, :292–296 |
| escalation penalty | $\times 0.8^{k}$ per escalated summons | :48, :301–302 |
| audit-divergence penalty | $\times 0.8^{k}$ | :44, :306–307 |
| floor on the penalty product | $0.5\,w_0$ (`minWeightFactor`) | :50, :332–335 |
| contribution caps | 4/epoch, 24 lifetime, most-recent-first | :52–54, :319–323 |
| recency decay | $c_e \cdot 0.9^{\text{age}}$ | :56, :321 |
| idle expiry | > 6 idle epochs ⇒ weight resets to $w_0$ | :58, :255–260 |

Selection probability ∝ $w/\Sigma w$ via the exponential-clock draw
(`selection.ts:221–229`, `weightedPriority`; default stake path
$\sqrt{\text{stake}}$, `:204–209`; 1%-of-volume eligibility gate `:275`).
**Concavity is per-identity, not per-capital-holder:** splitting $w$ across $k$
eligible identities multiplies the weight by exactly $\sqrt{k}$, and at the
1%-gate ceiling $k_{\max} = \lfloor w/(0.01V_m)\rfloor$ the achievable weight
$w/\sqrt{0.01V_m}$ is **linear** in stake — so the plutocracy price is carried
by the admission gates, not by the exponent
([`05-review-gapfills.tex.md`](05-review-gapfills.tex.md) §5, Lemmas 5.5–5.6).

### 5.5 SLA composite (the retainer metric)

Shipped `courtSlaComposite.ts` (bao.markets):

$$S \;=\; \text{ackRate} \times \big(\text{FLOOR} + (1-\text{FLOOR})\times \text{participationRate}\big),
\qquad \text{FLOOR} = 0.5 \;(\texttt{ACK\_PARTICIPATION\_FLOOR},\ :24)$$

composite formula at `:59`; ack rate = acked ÷ published
(`SummonsAckService.ts:1093–1096`). Pinned values: all-ack/zero-participation
= exactly 0.5, half-participation = 0.75, full = 1.0
(`mechanismAdversarial.test.ts:347–354, 357–362`, bao.markets #2294).
The retainer threshold $\tau$ is a **host duty** — the cap binds only relative
to a threshold set strictly above 0.5 (paper §7.4 lines 605–618; finding C-2
`REVIEW_SIMULATION.md:443–467`).

### 5.6 Payoff functions (strategic layer)

- **Juror $i$ seated in round $r$, coherent:**
  $\pi_i = \bar f^{(r)} + \lfloor P/|C| \rfloor$ − effort cost $c_p$.
- **Juror $i$ incoherent:** $\pi_i = -\alpha_I s^{(r)}$ + reputation flow
  $\Delta w$ via the overturned/flip flags (§5.4) — priced in Theorem 1/3.
- **Challenger:** merited win ⇒ bond returned + reward
  $R_c \le B_p - \ell$ (loser-bond-funded, closed budget); loss ⇒ forfeit
  $B_c$ into the pool (`bond_forfeit` inflow, `JurorPoolLedger.ts:53–54`).
- **Proposer:** mirror-symmetric (bond forfeited iff overturned, spec
  L200–201).
- **Venue:** zero float beyond the pool (spec L212, L336–337: external
  filing bonds = full expected panel cost, prepaid; loser pays).

## 6. Assumptions (numbered, referenced by 01–04)

| # | Assumption | Role / justification |
|---|---|---|
| **A1** | Discount factor $\delta \ge \delta^* = 0.95$ per epoch (weekly); jurors are patient enough that future income is priced. | Repeated-game viability (Theorem 3's stream-loss term). Numerics use $\delta = 0.95$. |
| **A2** | Dispute value $V \sim F$, median $m$, bounded tail $V \le V_{\max}$; the operator gates deep rounds by value (bond ≥ 25% of $V$ for $r\ge3$, spec L119), so theorems are stated per-$V$ and the aggregate reads over $F$. | Theorem 2's $r^*$ and Theorem 3's $\kappa^*(V)$ are functions of $V$; $F$ matters only when integrating. |
| **A3** | Collusion coordination: a bribe contract over the pool costs $\kappa_0$ per contracted member per attack (communication, contingent-contract enforcement across pseudonymous keys); threshold coverage requires $m^* = q^*\,N$ members, $q^*$ from the hypergeometric tail (§5 of 03). | Theorem 3's $\kappa^*$. |
| **A4** | Juror accuracy: a seated jury returns the true outcome with probability $a \ge a^* = 0.9$ per round (LLM-assisted jurors with evidence bundles; independence across rounds conditional on truth). On *manufactured* (frivolous) disputes accuracy $a_f \ge a^*$ a fortiori — the true outcome is well-defined and uncontroversial. | Theorems 1 and 2. The boundary forms (§2 of 01, §3 of 02) hold for any $a$; $a^*$ only selects the operating point. |
| **A5** | Selection unpredictability: the seed $H(\text{disputeEventId} \|\text{blockHash})$ is ungrindable ex ante at attack cost; seated-set membership is a hypergeometric-style draw w.r.t. any briber's information. | `selection.ts:163–173` (seed derivation); grind residual is PO-2, priced in `THREAT_MODEL.md` §6 PO-2 and bounded in 05 §4 (Theorem 5.4: viable only for $V \gtrsim R_{\text{blk}}/\Pr[X{=}t{-}1]$). |
| **A6** | Closed budget: juror income exists only as `fee_accrual` / `bond_forfeit` / `case_credit` inflows; no minting; venue zero float. | `JurorPoolLedger.ts:1–62`; L-0 above. |
| **A7** | Detection: commit–reveal and outcome history are public, and the retention monitors fire mechanically ($O_j > 20\% \Rightarrow$ demote, $>35\% \Rightarrow$ cooldown 30d, $>50\% \Rightarrow$ 100% standing-bond slash; 2 consecutive SLA-miss epochs ⇒ ejection — spec L191, L253–254). Modelled as per-epoch detection probability $p_{\det} \to 1$ for sustained collusion. | Theorem 3's stream-loss term. |
| **A8** | Jurors risk-neutral over sats at demo/testnet stake sizes; effort cost $c_p > 0$ per participation; no liquidity constraints on bonds (escrow-before-validity makes bonds prepaid, never leveraged). | Standard; relaxed in remarks. |
| **A9** | The venue/host $H$ executes the shipped policy faithfully; its own misbehaviour is out of scope (trust boundaries pinned in `THREAT_MODEL.md` §5 P1–P12). | Scope bound. |

## 7. What is code-pinned vs spec-pinned (honesty ledger)

| Parameter | Status | Binding artifact |
|---|---|---|
| Reputation weight formula + all 13 parameters | **code-pinned** | `jurorReputationWeight.ts:38–62` + tests `mechanismAdversarial.test.ts:541–545` |
| SLA composite + 0.5 floor | **code-pinned** | `courtSlaComposite.ts:24,59` + pins `:347–362` |
| Fee carve `jurorPoolBps`, closed ledger | **code-pinned** | `feeCalculator.ts:219–235`, `JurorPoolLedger.ts:39–62,229–233` |
| Ladder machinery (rounds, host-driven escalation, bounds) | **code-pinned** | `courtConfirmationMachine.ts:242–247`, INV-CONF-29 |
| Slash fractions, stake/bond doubling schedule | **code-pinned** (protocol layer) | `escrow.ts:93–96,114–155` |
| Uncontested 0.2%, premium 7×, loser-bond 2%, symmetric 3% bonds, panel sizes, τ | **spec-pinned** | `UNIVERSAL_JURY_CONFIRMATION.md` L108–124, L197–227 (merged design doc; host-layer constants the theorems take as given) |
| Retainer threshold τ value | **open host duty** — the theorems state conditions **in τ** and flag the pass-mark region τ ≤ 0.5 | paper §7.4; C-2 |

Where a theorem needs a spec-pinned constant it says so; no theorem below
treats a spec-pinned number as if code enforced it. This is the same
honesty rule as `docs/proofs/README.md` §3 (premises registry).
