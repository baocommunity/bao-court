# Delivery status — what is proven, where, and how to check it

**As of 2026-11-13.** This page is the honest scoreboard: every claim below points
at a transaction, an artifact, a tag, or a command you can run. If a thing is not
proven, it is in §6 rather than dressed up.

Companions: `docs/FROST_COURT_ORACLE_PAPER.md` (the paper),
`docs/EVALUATION.md` (evidence tables), `docs/CAMPAIGN_REPORT.md` (the narrative),
`docs/REVIEWS_INDEX.md` (every review round + the failure-mode taxonomy).

---

## 1. The four rails

| Rail | Network | Court-locked | Juror-bound | Evidence |
|---|---|---|---|---|
| **On-chain** | **testnet4** | **yes** — 2-of-2 court⊕juror P2WSH, 100,000 sat ×3 | **yes** — the script commits the juror key | deposit `b2b393ae…d935b5` (0.00563475 tBTC, block **161026**); bonds `d4967edf…:1`, `14f88077…:1`, `9d9269ef…:1`; verified by first-party `bitcoind-tn4-relay` + `mempool.space/testnet4`; slash spend signed with both keys, `testmempoolaccept {allowed:true, vsize:137}` `0afc8922…`, **not broadcast** |
| **Liquid** | **testnet** | **yes** — covenant lock, 100,000 sat ×3 | **yes (leaf)** — the lock's leaf commits the juror key, `OP_DROP`ped so the court still slashes unilaterally | per-seat bond addresses derived from `(group key, jurorPubkey)`; outpoints `63342daa…:0`, `be0daf85…:0`, `0bb85a03…:0`, `BOND_RAIL_PROVEN` with `jurorBinding:"committed"` and **blockstream + liquid.network** agreeing; the same outpoints under another juror → `BOND_JUROR_MISMATCH` ×3, the legacy court-only coin `c2f11565…:0` (lock `tex1p54n…`) → `BOND_JUROR_UNBOUND`; court spend constructed and validated (output key from the leaf, NUMS control block, BIP-340 under the group key, leaf `PUSH32 OP_DROP PUSH32 OP_CHECKSIG → TRUE`) **not broadcast**; a ceremony seated all three bonds (1.9–2.1 s, one verified signature) and excluded a box presenting another seat's bond (`ROSTER_BELOW_THRESHOLD`) |
| **Cashu** | private signet | n/a — escrow swap | custody record per juror | mint Nutshell 0.18.2 `BAO-Testnet-Mint`; swap → custody, NUT-07 `UNSPENT×5` vs juror `SPENT×3`; slash melted 100 sat (treasury +90); reconciliation `custody + treasury + returned + atRisk + fee == bonded` as a DB CHECK |
| **Lightning** | private signet (CLN) | n/a — held HTLC | payment hash per bond | **settle** `c7930f3f…` → court 16,200→66,200 / payer 183,800→133,800; **cancel** `385fd673…` → both restored; live `BOND_EXPIRED`; ends `{held:0,pending:0}` |

A bond that cannot be **proven** is refused (`BOND_UNVERIFIABLE`), never passed:
one source down, two sources disagreeing, a spent or replaced output, a wrong
asset or script, a wrong network, a bond for another case, an odd-Y key
(`BOND_KEY_NOT_XONLY_LIFTABLE` — such a bond is unspendable), or a bond for
another seat — `BOND_SCRIPT_MISMATCH` on-chain (the 2-of-2 *is* the binding) and,
on Liquid, `BOND_JUROR_MISMATCH` (another seat's or court's per-seat lock),
`BOND_JUROR_UNBOUND` (the pre-2026-11-13 court-only lock, which commits no juror
and must be re-locked) or `BOND_PROOF_UNPARSEABLE` (no juror key to bind against).

## 2. The ceremony

| Property | Evidence |
|---|---|
| Runs across **separate machines** | relay on `vps16gb`, jurors on `vps16gb` / `bao8gb` / `bao-testnet`, coordinator local — not loopback |
| Threshold correctness | N=3: **k=2** and **k=3** both produce one group key and one signature, verified independently by the coordinator from the published commitments |
| **Bond-gated seats** | `BAO_COURT_BOND_CHECK_CMD` per juror, enforced after key publication and **before the roster**; three funded bonds → three `bondVerified:true`, one signature |
| Fails closed on a bad bond | a genuinely **spent** bond loses its seat → `ROSTER_BELOW_THRESHOLD` → **no key, no signature** |
| Stable identities | `--juror-keys`: a seat is a proven **key** plus a proven **bond**; identities are never silently regenerated |
| Crash safety | SIGKILL mid-signing over ssh → survivors `SIGN_MISSING_REVEAL`, no signature anywhere |
| Replay is not equivocation | a byte-identical re-delivery is collapsed by **signed event id**; a genuine two-commitment case still blames the right juror |
| Continuous | a 6-hourly unattended soak rotates happy-k2 / happy-kn / kill / replay / reorder |

## 3. Formal and mechanical evidence

| Layer | Artifact | Result |
|---|---|---|
| Lean 4 | `proofs/lean4/` | 42 declarations, **no `sorry`**, axioms `propext` + `Quot.sound` only; `safe_depth_bound` (`E[π](d) < 0 ↔ d < flipRound`), `safe_monotone`, `unsafe_witness`, `one_hash_one_index`, `consumed_not_reused`, `reachable_wellFormed` |
| Model checking | `proofs/mechanized/` | Apalache exhaustive depth 10/8; 58 Quint scenarios |
| State-space | model checker | 3,869,232 states · 213,521,172 applications · **60,020,684 illegal-witness probes, 0 accepted** |
| Independent implementation | `scripts/differential/` | a Python wire reference written from the spec; 100,000 cases → **0 disagreements**, 51,252 accepted requests byte-identical |
| Mutation | `docs/MUTATION_TESTING*.md` | 101 mutants across three campaigns; the survivors that mattered became spec holes, all closed |
| Corpora | `docs/benchmarks/SCALE_CAMPAIGN_V2.md` | 1,587,000 units / **8,286,823 assertions** / 0 failures |
| Soak | `docs/benchmarks/SOAK_3DAY.md` | 30,000 settlements, 3 epoch boundaries, 32/32 assertions with fault injection |
| Contract | `scripts/reproduce.sh` | 13 stages, digit-exact fixture, `REPRODUCED` |
| Cross-check | `scripts/cross-check.mjs` | 286 claims / 521 refs, dangling codes fail the build |

## 4. The continuous programs (running)

```
rail soak       5-min light · hourly full adversarial · 6-hourly deep
                JSONL per cycle · boot-gap accounting · per-source health
                298 cycles at the last check · ETA 2026-11-16T04:18Z
ceremony soak   6-hourly, one scenario per run, JSONL, boot-gap accounting
```

The discipline that makes these worth running: every failure is classified as a
**rail bug**, a **harness bug**, or a **reorg** — never averaged away. Running
tally: **1 genuine rail bug** (Liquid confidential outputs: spend state was read
after value readability, so a spent bond returned `VALUE_UNVERIFIABLE`), **8
harness bugs**, 0 open.

## 5. Reproduce

```bash
git checkout <tag>                  # bao-court
bash scripts/reproduce.sh           # 13 stages → VERDICT
npm test                            # 2,029 passing
node scripts/cross-check.mjs        # 286 claims / 521 refs
(cd proofs/lean4 && ./run.sh)       # 42 declarations, no sorry
npm run campaign:full               # 1.59M units / 8.29M assertions
(cd scripts/differential && node run.mjs --profile full)   # 100k, 0 disagreements
node scripts/court/multi-process-ceremony.mjs --matrix     # Byzantine relay matrix
```

Host-side rail checks are described in `docs/operations/RAIL_BACKED_BONDS.md`
(Liquid / on-chain / Cashu / Lightning, per rail × network × source).

## 6. Not proven (and why)

| Open | Why | Trigger that forces it |
|---|---|---|
| **A Liquid bond commits the juror but the juror cannot veto — or be protected from — the court's slash** | the leaf is `<juror> OP_DROP <group> OP_CHECKSIG`: the court slashes unilaterally (LJ-1's closure, §8.5), so a hostile juror cannot block a slash, and symmetrically a malicious court is not prevented from slashing an honest one | PO-15 (settlement/release binding); the on-chain 2-of-2 takes the opposite trade — it protects the juror, and needs the juror's cooperation to move the bond at all |
| **The public dispute (filer) bond is still shape-only** | the juror *seat* bond is juror-bound on both public rails; the bond a trader posts when filing a dispute still pays the legacy court-only lock and is verified by shape (`formatOnlyBondVerifier`) | binding the filer bond to the filer's pubkey — same mechanism, one more caller (host-side) |
| Testnet4 court-lock was **human-funded** | the relay node has **no wallet**, so the 49-BTC coinbase is not ours | a funded testnet4 wallet in the deployment |
| Private-signet rails are not public evidence | Lightning and Cashu are not enabled on public testnet | public testnet enabling them |
| One operator holds court key, wallet and boxes | test infrastructure | a second, independent operator |
| Bonds prove collateral **at verification time** | a bond prices the option, it does not remove it | — (by design) |
| Release is host-mediated (PO-15) | v1 settlement binding | on-chain verdict enforcement |
| Majority collusion is κ-bounded | mechanism design | — |
| No external replication | needs an unaffiliated evaluator | submission |

## 7. Where the artifacts live

- **Protocol**: `baocommunity/bao-court` — tags `v0.11.0 … v0.16.2`, each with a GitHub Release.
- **Host**: `baocommunity/bao.markets` — `packages/lib/frost-court` byte-exact mirror, plus the rail verifiers and the soak programs.
- **Client**: `2140wtf/2140wtf` — `court-core` mirror, pinned to the tag.
- **Paper**: three byte-identical copies (`docs/architecture/frost-plan/`, `public/`, and the protocol repo), sha256 `35185563…`.
