# docs/proofs/economics/ — The Incentive Theorems

Round 19 of the symposium program: the incentive **design** of the BAO Court
turned into theorems, with every parameter bound to the shipped code (or,
where a constant is a merged design constant rather than TypeScript, marked
**spec-pinned** and cited to its document line — the distinction is never
blurred; see `00-model.tex.md` §7). Companion to this round's parallel
mechanization track (`proofs/mechanized`, landing as
`docs/proofs/mechanized/`), which machine-checks the *protocol* theorems; the
four theorems here are the
*economics* layer and are analytic. This round's deliverable discharges or
precisely bounds the two residuals the threat model left open: **PO-1**
(majority-collusion) and the R10/R16 Goodhart findings.

---

## 1. The theorems

| # | File | Theorem | One-line content | PO-1 / R10-R16 link |
|---|---|---|---|---|
| 0 | [`00-model.tex.md`](00-model.tex.md) | — (the game) | Players, types, phase action sets, information structure, payoff functions reconstructed from code with file:line for every parameter; assumptions A1–A9 numbered. | groundwork |
| 1 | [`01-farming.tex.md`](01-farming.tex.md) | **Farming negative-EV** | Challenge-farming EV $= (1-a_f)\rho V - a_f\beta V - c_f < 0$ iff $a_f > \rho/(\rho+\beta) \le 0.5$ at shipped bonds; at $a_f = 0.9$: **−2.4% of $V$ per attack**, optimum farming rate zero. Compounding asset bounded: $w \le 3.81\,w_0$. | R10 bond-gaming (ADV-ECON-b) — quantitative form |
| 2 | [`02-ladder.tex.md`](02-ladder.tex.md) | **Escalation IC** | Marginal EV of escalating decays at $((1-a)/3a)^r$; $r^{*} = \lfloor \ln(O_0G/b_0)/\ln(3a/(1-a)) \rfloor$; at shipped $a=0.9,\beta=0.03$: **$r^{*} \le 2$ for every prior ≤ 270:1** — the shipped `maxLadderRounds = 2` default is incentive-tight. Corollary: griefing is a bonded transfer to the cohort (ledger identity, zero venue float). | justifies the ×3 ladder economics |
| 3 | [`03-collusion.tex.md`](03-collusion.tex.md) | **Collusion condition-bounded** | Resistance iff $V < C_{\mathsf{pay}}(V) + \kappa_0 m$; zero-κ region $V^{*}$ = **157k** (moderately-contested) to **752k sats** (fully-contested, cap-2 ladder) — powered by the victim's own Theorem-2 escalation; weakly-contested verdicts are κ-bounded only (honest residual). Amortized/hit-and-run cartels above the payment-mass region: **open**, bounded not closed. | **PO-1: CONDITION-BOUNDED** (was: unmodeled) |
| 4 | [`04-goodhart.tex.md`](04-goodhart.tex.md) | **Goodhart characterized** | Farmer's optimum is the corner $p^{*} = \max(0, 2\tau-1)$; cap binds iff $\tau > 0.5$ (C4.1, proven); non-profitability guard $\tau \ge 1 - \bar F/(2c_pT)$ (C4.2, proven); PO-12 reset loop quantified: 13-epoch cycle, long-run **0.573·$w_0$** vs 0.5·$w_0$ under the fix (+14.6% farming subsidy; pure ack-farmer unaffected — its cap is C4.1). | **R10/R16 C-2 + PO-12: proven conditions** (was: TODO) |

## 2. Dependency graph

```
Assumptions A1–A9 (00-model §6) + closed-budget lemma L-0
│
├── Lemma 1.1 (reward ≤ loser-bond budget) ── Lemma 1.2 (β symmetry)
│        │                                        │
│        ▼                                        ▼
├── T1 Farming negative-EV ◄── Lemma 1.3 (w ≤ 3.81 w0, bounded compounding)
│        │
│        │  (same jury-accuracy a, Bayes update (2.1))
│        ▼
├── T2 Escalation IC  ──► r* ◄── shipped cap (maxLadderRounds = 2)
│        │                             │
│        │  (R = min(cap, r*_honest): honest escalation is the bribe price)
│        ▼                             │
├── T3 Collusion ──────────────────────┘
│        ├── T3.1 resistance region κ*(V), V* table
│        └── T3.2 amortized-cartel limit (open region, honest)
│        │
│        │  (floor 0.5 w0 + PO-12 reset weaken the deterrence terms)
│        ▼
└── T4 Goodhart ── Lemma 4.1/4.2 (linearity ⇒ corner) ──► C4.1, C4.2, T4.4
         (T4.4's reset loop feeds back into T3 Remark 3.3)
```

Reading order: 00 → 01 → 02 → 03 → 04. T1 and T2 share A4's accuracy $a$;
T3 consumes T2's endogenous escalation depth; T4 shares T3's floor/reset
observations and closes the R10/R16 loop. The protocol-side theorems the
mechanization branch proves (`docs/proofs/01–05`: encoding, Merkle, tally,
machine safety, attestation soundness) are *upstream* of everything here:
the economics assume the tally is well-defined (T3 there), the machine safe
(T4 there), and attestations sound (T5 there) — a bribe analysis of a game
whose referee is broken would be worthless.

## 3. How each theorem binds to shipped code

| Theorem | Code-pinned parameters | Spec-pinned parameters | Pinned by tests |
|---|---|---|---|
| T1 | `JurorPoolLedger.ts:52–62,229–233` (closed budget, bond_forfeit inflow); `jurorReputationWeight.ts:52–56,319–335` (caps, recency, floor); `selection.ts:275` (1% gate) | β = 3% symmetric bonds, ρ ≤ 3% reward, ℓ = 2% loser-bond funding (`UNIVERSAL_JURY_CONFIRMATION.md` L212–214, L200–201) | `mechanismAdversarial.test.ts` (attack suite, #2294); escrow tests |
| T2 | `courtConfirmationMachine.ts:242–247` (maxLadderRounds default 2, 1..5); `confirmationMachineTypes.ts:160`; INV-CONF-29 | ladder table 4×→364×, skip-rule, 25%-of-value gate for r ≥ 3 (spec L108–121) | `multiRoundLadder.test.ts`; `propertiesConfirmation.test.ts` P3 |
| T3 | `selection.ts:163–229` (unpredictable draw); `escrow.ts:93–96,147` (α_I, stake); retention monitors are host policy | round-0 quorum 3-of-5; retention thresholds 20/35/50%, ejection (spec L191, L253–254); J ≈ 500 sats/d steady state (spec L221–223) | clawback idempotency INV-CONF-26/27/28; `simulateCourt.test.ts` |
| T4 | `courtSlaComposite.ts:24,59` (composite, FLOOR 0.5); `SummonsAckService.ts:1093–1096`; `jurorReputationWeight.ts:60–62,255–259,292–335` (ack target 0.95, expiry→w0, ×0.8, floor) | τ (retainer threshold — **open host duty**, theorems stated in τ) | `mechanismAdversarial.test.ts:347–362` (0.5/0.75/1.0), `:541–545` (0.8³) |

## 4. Empirical validation — the incentive Monte Carlo (spec'd, not built)

The original plan's simulation, specified so it can be built without
re-deriving anything. Deterministic and seeded (frost-court convention: pure
functions + explicit clocks, like `scripts/model-check.mjs` upstream).

**Strategies** (per juror; per the spec's own list, L413):

1. `honest` — acks, participates when seated, votes truth.
2. `rubber-stamp` — acks, always confirms the proposal (exercises the
   overturn/clawback path when proposals are wrong).
3. `coherent-farmer` — T4's optimum: ackRate 1, participation exactly
   $p^{*} = \max(0, 2\tau-1)$.
4. `colluder` — accepts delivery-contingent bribes above the (IR) floor of
   03 §1; cartel sizes 3…q*·N.
5. `challenge-farmer` — T1's attacker: ν unmerited challenges/epoch on
   correct outcomes.
6. `idler` — PO-12's loop: farm → idle-expire → reset (T4.4's cycle).

**Sweeps** (each maps to a theorem boundary — the sim's job is to measure
where reality sits relative to the proven inequality):

| Sweep | Range | Validates |
|---|---|---|
| jury accuracy $a$ | 0.5 … 0.99 | T1 boundary $a^{\dagger}$; T2's $r^{*}$ table; T3's $p_{\mathsf{flip}}$ |
| disputed premium $k$ | 1 … 10 (band 6–8) | juror income vs farming margin (T1's $\bar F$ term) |
| bond multipliers $(\beta, \rho)$ | 0.5× … 3× shipped | T1's flip inequality $\beta \ge \rho(1-a_f)/a_f$ |
| retainer threshold $\tau$ | 0.45 … 0.95 | C4.1's pass-mark region (τ ≤ 0.5 must show farmers clearing) |
| pool size / active set | 50 … 10,000 | T3's coordination mass; stream-dilution feedback |
| discount factor $\delta$ | 0.5 … 0.99 | T3.1's stream term; the amortized-cartel boundary (T3.2) |
| victim confidence / escalation cap | $p_0$ grid; cap 1 … 5 | T2's $r^{*}$ vs shipped default 2; T3's $V^{*}$ rows (157k/752k) |

**Metrics:** per-strategy epoch EV (sign must match the theorems' predicted
regions); cohort income redistribution (Gini across strategies); farmer
long-run average weight (must reproduce 0.573·$w_0$ for the penalized cycle of T4.4);
colluder detection lag in epochs vs the 20/35/50% monitor thresholds.

**Acceptance criteria** (the sim *fails* if the math is wrong or the code
drifted): (i) `challenge-farmer` EV < 0 whenever measured $a_f > \rho/(\rho+\beta)$;
(ii) `coherent-farmer` clears τ exactly at $p^{*}$ and never above (corner);
(iii) `colluder` EV > 0 iff $V > V^{*}(\delta, J)$ at κ = 0 — the sim's $V^{*}$
must match 03's table (157k / 752k sats) within the sweep's discretization;
(iv) `idler`'s long-run weight = 0.573·$w_0$ (penalized cycle) — the PO-12
loop, reproduced — and the pure ack-farmer's composite pinned at 0.5.

**Harness sketch:** reuse the court package's pure machines as the game
engine (selection → confirmation → ladder → escrow ledger → weight
function), drive $H$ by the shipped cron semantics, run 10⁴ epochs × 50
seeds; output the sweep tables as fixtures next to
`mechanismAdversarial.test.ts`. Estimated ~600 lines; deliberately **not
built in this round** — the theorems define what it must confirm, so
building it before the theorems landed would have validated nothing.

## 5. What this round did NOT do (honest ledger)

- **PO-1 is condition-bounded, not discharged** — 03's Theorem 3.2 names the
  open region (amortized/hit-and-run cartels on high-value disputes) and
  Remark 3.3 bounds it. The threat model's closure path (raise $t$ / jury
  size per market value) remains the answer for that region.
- **$a_f$, $c_p$, $\bar F$, $\kappa_0$ are measurements, not constants** —
  the theorems are stated in them; the Monte Carlo is the measurement
  instrument, spec'd above.
- **The retainer threshold τ is still an open host duty** — but it is no
  longer a TODO: C4.1/C4.2 are the proven conditions any τ choice must
  satisfy.
