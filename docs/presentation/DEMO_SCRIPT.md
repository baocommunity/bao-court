# BAO Court — LIVE Demo Script (5 minutes)

**Version:** round 16 (presentation artifacts) · tracks `@bao/court` v0.10.2
**Companion:** [`OUTLINE.md`](OUTLINE.md) · [`FIGURES.md`](FIGURES.md)

The strongest 5 minutes possible: the whole court runs live, the state-space
sweep runs live, the claim→evidence index verifies live, and the one-command
reproduction contract shows its committed REPRODUCED verdict. Every expected
output below is copied from a real run on this tree or from the committed log
(`docs/benchmarks/repro-log-2026-11-10.txt`) — nothing is invented.

---

## 0. Pre-flight checklist (before the talk — 10 min)

```bash
git clone https://github.com/baocommunity/bao-court && cd bao-court
npm ci                      # 73 packages, ~1 s warm / <1 min cold
node --version              # MUST be >= 22 (baselines: v22.x)
```

- [ ] `npx tsx scripts/simulateCourt.ts` prints `RESULT: ALL GREEN` (1–2 s)
- [ ] `node scripts/cross-check.mjs` prints `OK` (0.1 s)
- [ ] `npx tsx scripts/model-check.mjs --only "signing n=2"` prints `rawThrows=0` (≈1 s)
- [ ] Terminal font ≥ 16 pt, one window, prompt on a fresh line
- [ ] Have `docs/benchmarks/repro-log-2026-11-10.txt` open in an editor pane (Fallback B for beat 4)

**Note:** do NOT plan to run `scripts/model-check.mjs --fast` or
`reproduce.sh` live — the fast sweep is ~574 s and even `--quick` is ~3.5 min
(committed measurements). The demo uses the committed logs for those; see
Fallback B below. (`reproduce.sh` supports `--quick` / `--full-model-check`,
not `--fast-mode`.)

---

## Beat 1 — 0:00–0:30 — Framing

**Say:** "Everything you've seen in slides, we're going to *run*. One repo,
one command each, no network after install, fully deterministic. The demo
*is* the paper's evaluation methodology."

Show the repo root (`ls`): ~70 source files, `scripts/`, `docs/`, and the
committed evidence: `__fixtures__/model-check-summary.json`.

---

## Beat 2 — 0:30–1:45 — The whole court, deterministically

```bash
npx tsx scripts/simulateCourt.ts
```

**Expected output (exact, captured 2026-11-10):**

```
===== BAO COURT SIMULATION =====
  [ ✔ ] selection: selected 5/12 (2 backups)
  [ ✔ ] dkg: threshold 4/5, group d243bcb9d57e…
  [ ✔ ] vote: winner=YES, supporting=4, invalid=0
  [ ✔ ] sign: attestation sig fe32352a1e86b294… (kind 39007)
  [ ✔ ] validate: attestation valid=true
  [ ✔ ] escrow: slashPool=5000 sats, integrity=true
  [ ✔ ] ln: settled=4 coherent, cancelled=1 incoherent
  [ ✔ ] liquid: branch=judge, addr=tex1qdzh32c0…, fee=10000sats, tx=fake-txid-1
RESULT: ALL GREEN
  selected=5 group=d243bcb9d57e… attestation=true slashPool=5000
  LN settled=4 cancelled=1 liquid=tex1qdzh32c00ch3s89udh9mutnevfwdzppj8pg9dnf69pz45umn34vgq4rerfv tx=fake-txid-1
```

Run it **twice**; diff the runs live:

```bash
npx tsx scripts/simulateCourt.ts > /tmp/sim1.txt && npx tsx scripts/simulateCourt.ts > /tmp/sim2.txt
diff /tmp/sim1.txt /tmp/sim2.txt
```

**Expected diff (exactly ONE line):**

```
6c6
<   [ ✔ ] sign: attestation sig 012a339514b45c60… (kind 39007)
---
>   [ ✔ ] sign: attestation sig b9a108992ac0c721… (kind 39007)
```

**Say:** "Same seed → same jury, same group key `d243bcb9…`, same Liquid
address, same slashing decisions — byte-identical everywhere except the
attestation signature bytes, because FROST nonces are fresh CSPRNG per
ceremony *by design*. A reused nonce leaks shares — vector H in the threat
model — so determinism here deliberately stops at the nonce."

**Points to hit:** 8 stages in ~1 s — lottery selection, Pedersen DKG,
commit–reveal vote with one incoherent juror, FROST threshold signing,
production-path attestation validation, escrow slashing with integrity check,
LN hold settle/cancel, Liquid escrow broadcast.

---

## Beat 3 — 1:45–2:45 — Exhaustive model checking, live

```bash
npx tsx scripts/model-check.mjs --only "signing n=2"
```

**Expected output (exact, ~1 s; captured 2026-11-10):**

```
[model-check] mode=full instances=1 filter=signing n=2
[model-checking] signing n=2 t=1 [clock 10/25]
  states=2532 (abstract=127)  progressEdges=9283  selfLoops=2802  applications=78588
  terminal: expired=464 aborted_peer=754 aborted_coordinator=754 attestation_published=260  parking: none
  typedThrows=66503  rawThrows=0  illegalEventChecks=60830
  non-aborted-terminal-reachable (incl. terminals)=300/2532  determinismPaths=200  wallMs=1041

[model-check] WROTE …/__fixtures__/model-check-summary.json
[model-check] totals: {"instances":1,…,"rawThrows":0,…}
[model-check] wall time: 1.0s
```

> **Heads-up (found in the round-17 dress rehearsal):** this beat rewrites
> `__fixtures__/model-check-summary.json` with the 1-instance totals. If you
> run Beat 4's cross-check without restoring first, it will correctly report
> `MC-3: totals.instances = 1, expected 13` / `MC-4:
> determinismPathsReplayed = 200, expected 2600` — the gate working, not a
> regression. Restore between beats:
> `git restore __fixtures__/model-check-summary.json`

**Say:** "Every reachable state × every event application, asserting five
property classes on **every edge** — phase legality, data invariants with
real SHA-256 re-derivation and real secp256k1 nonce points, no dead ends,
acyclic progress, determinism. The headline sweep is 13 instances:
**3,145,632 states, 128.5 million event applications, 112 million typed
throws, and zero untyped `TypeError`/`RangeError`** — that ran in 574 s
committed in the reproduction log. This one instance is the same explorer,
same machines, live."

Then show the committed headline numbers in one line:

```bash
node -e "const f=require('./__fixtures__/model-check-summary.json');console.log(f.totals??f)"
```

(Fallback-safe: even if the fixture shape differs, the numbers below are the
committed ones to quote from memory or the slide.)

> **Committed full sweep (`__fixtures__/model-check-summary.json`, PR #53/#63):**
> states **3,145,632** · applications **128,522,740** · typed throws
> **112,076,252** · illegal-event checks **68,077,138** · **raw throws 0** ·
> progress edges 11,716,954 · determinism paths 2,600, all byte-identical.

---

## Beat 4 — 2:45–3:30 — Claim → evidence, live

```bash
node scripts/cross-check.mjs
```

**Expected output (exact, ~0.1 s):**

```
cross-check: 272 claims indexed, 493 evidence refs verified
claims by kind:   {"invariant":145,"paper":71,"model-check":7,"bench":7,"suite":4,"error-taxonomy":5,"finding":12,"audit":21}
claims by evidence: {"test":240,"gap":12,"doc":4,"fixture":4,"bench":8,"model-check":1,"script":1,"pkg":2}
gap register entries: 17

OK — every evidence pointer in docs/CROSS_CHECK.md resolves.
```

**Say:** "272 claims across four sources — 145 invariants, 71 paper claims,
21 literature-audit claims, 12 findings — each pointing at a test name, a
fixture key, a bench id, or a registered gap. The script re-resolves all 493
pointers against the tree *right now* and exits non-zero on a dangling one.
The docs cannot drift silently. 95.2% carry executable proof; the 13 open
gaps are registered with planned proofs — that's the roadmap, not a
confession."

---

## Beat 5 — 3:30–4:30 — The one-command reproduction contract

**Fallback A (preferred — committed log, zero risk):** open
`docs/benchmarks/repro-log-2026-11-10.txt` and show the final block:

```
==================== VERDICT ====================
 commit: 7ab0d441f182   node: v22.23.2   date: 2026-11-10T09:15:51Z
 flags: (default: full contract)
-------------------------------------------------
 [a] clean-env check                                      PASS (0.034s)
 [b] npm ci (only network-dependent stage)                PASS (0.959s)
 [c] npm test (full suite) → json + junit               PASS (155.712s)
 [d] typechecks ×3 (impl / scripts / tests)              PASS (6.321s)
 [e] simulate:court (end-to-end whole-court deterministic sim) PASS (1.052s)
 [f1] model-check --fast (deterministic state-space sweep) PASS (574.253s)
 [f2] fixture comparison (regenerated == committed, digit-identical) PASS (0.544s)
 [g1] bench --json (single pass)                           PASS (260.658s)
 [g2] bench vs baseline (±20% bound, FAIL at >3x)         PASS (0.029s)
 [h] cross-check.mjs (every evidence pointer in docs/CROSS_CHECK.md) PASS (0.082s)
 [i] suite pass-counts                                    PASS (0.846s)
-------------------------------------------------
 RESULT: REPRODUCED — every artifact PASS — total 999.950s
```

**Say:** "One command from a clean clone — `bash scripts/reproduce.sh` —
regenerates every artifact the paper cites: the full 1,534-test suite, three
typechecks, the simulation, the model-check fixture **digit-identical**,
bench within ±20% of baseline, the cross-check, and the contract-suite
pass-counts. Total: 17 minutes. This is the committed run — and the model
check you just saw live is stage [f1]'s explorer."

**Fallback A′ (only if ≥4 spare minutes and a quiet host, load < 2):**
`bash scripts/reproduce.sh --quick` live (~3.5 min) — start it in beat 1's
background and show the VERDICT here. **Skip if the room is loaded** —
µs-scale numbers are not reproducible on a loaded box (the load-20 exclusion
in BASELINE.md); showing the committed log is always correct.

---

## Beat 6 — 4:30–5:00 — Close

**Say:** "So: a threshold oracle where nobody holds the key, every outcome
gets panel evidence, one signature certifies an epoch — and none of that is a
claim: 145 invariants from the guards, 3.1M states with zero untyped throws,
differential parity with zero disagreements, 95.2% claim coverage that a
script keeps honest, and one command that regenerates all of it.

**The one-sentence version:** *BAO Court is a just-in-time FROST threshold
oracle for prediction-market disputes — a jury drawn by public verifiable
lottery runs distributed key generation so no party ever holds the group
secret, votes under commit–reveal, and produces a single ordinary Schnorr
signature over the frozen verdict that any third party can verify.*"

Leave on screen: `RESULT: REPRODUCED — every artifact PASS`.

---

## Fallbacks (if live fails)

| Beat | Failure | Fallback |
|---|---|---|
| 2 | `simulate:court` throws / tsx missing | Paste the expected output above (it is committed evidence — the same pipeline is asserted by `__tests__/simulateCourt.test.ts`); then run `npx vitest run __tests__/simulateCourt.test.ts` (~5 s) and show `ALL GREEN` from the test |
| 2 | "sig differs" observation breaks the determinism story | It doesn't — it *is* the story: nonce freshness is a security feature (vector H). Pre-empt with the one-line diff explanation |
| 3 | `--only` instance unexpectedly slow (>10 s, loaded host) | Show the committed fixture totals (Beat 3's node one-liner) + the full-sweep row from the repro log; say "live on a quiet box: ~1 s, see the committed 574 s full sweep" |
| 4 | cross-check FAILs (docs edited since) | The failure output names the dangling pointer — say "the gate works: it just caught that docs moved ahead of evidence", then show the committed log's stage-[h] PASS line |
| 3→4 | after Beat 3, cross-check reports MC-3/MC-4 | Expected: Beat 3 rewrote the committed fixture (see the Beat 3 heads-up). `git restore __fixtures__/model-check-summary.json`, re-run — `OK` |
| 5 | log file unavailable | VERDICT block is reproduced in this document — read it from the slide |
| any | Node < 22 | The env check prints `FAIL: Node >= 22 required` — run beats 2/4 as committed-output read-alongs; the story survives |

## Timing risk

If the room runs long, cut **Beat 3's committed-fixture one-liner** (the
slide carries the numbers) — never cut Beat 2 (the only "it actually runs"
moment) or Beat 6 (the contribution statement).
