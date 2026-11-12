# Distributed ceremony — three real boxes, one real network

**Status: ran and passed, 2026-11-11.** One juror per physical box, a relay on a
separate box, a coordinator on a fourth machine, both happy runs (k = 2 and
k = 3) and a real SIGKILL delivered over ssh mid-signing.

This document answers the standing review objection about the multi-process
harness: *"nothing ran distributed — it is one kernel, one clock, one machine."*
The harness (`docs/MULTI_PROCESS_CEREMONY.md`) is still the fast regression
gate; this run is the evidence that the same ceremony, the same wire format and
the same receive-side gates work when the boxes are genuinely separate.

Artifacts: `docs/benchmarks/distributed-ceremony/`
(`dist-2026-11-11T23-04-28-{happy-n3-k2,happy-n3-k3,kill-n3-k3,summary}.json`,
`loopback-baseline.json`).

---

## 1. Topology actually used

```
        ┌──────────────────────────────────────────────────────────────┐
        │  coordinator  baospace (Bob)   Node v22.22.1, 16 cores       │
        │  • builds juror.mjs with esbuild (single file, no node_modules)
        │  • prepares the PUBLIC roster, scp's bundles + roster + token
        │  • launches one juror per box over ssh (fire-and-forget)
        │  • watches the relay's receive log, delivers the SIGKILL over ssh
        │  • re-derives the group key and verifies the aggregate itself
        └───────────────┬──────────────────────────┬───────────────────┘
                        │ ssh                      │ ssh
        ┌───────────────▼───────────┐   ┌──────────▼──────────────────┐
        │ juror 1  vps16gb          │   │ juror 2  bao8gb             │
        │ ubuntu-16gb-nbg1-1        │   │ bao8gb                      │
        │ Node v22.22.0, 8 cores    │   │ Node v20.20.0, 8 cores      │
        │ ALSO HOSTS THE RELAY      │   │ (killed in scenario B)      │
        └───────────────┬───────────┘   └──────────┬──────────────────┘
                        │  HTTP/1.1 JSON, bearer token, public IP
        ┌───────────────▼───────────────────────────▼─────────────────┐
        │  relay  46.225.208.172:18471  (plain node:http, high port,  │
        │  bound 0.0.0.0 for the duration of the run only)            │
        └───────────────▲─────────────────────────────────────────────┘
                        │  HTTP/1.1 JSON
        ┌───────────────┴───────────┐
        │ juror 3  bao-testnet      │
        │ ubuntu-26, 8 cores        │
        │ Node v22.22.0 — STATIC    │
        │ tarball in /opt (no apt)  │
        └───────────────────────────┘
```

| idx | box | hostname | Node | cores | role |
|---|---|---|---|---|---|
| 1 | `vps16gb` | `ubuntu-16gb-nbg1-1` | v22.22.0 | 8 | juror + relay host |
| 2 | `bao8gb` | `bao8gb` | v20.20.0 | 8 | juror (victim in the kill run) |
| 3 | `bao-testnet` | `ubuntu-26` | v22.22.0 (static, `/opt/bao-court-node`) | 8 | juror |
| — | `baospace` | `Bob` | v22.22.1 | 16 | coordinator only (never a juror) |

Three distinct kernels, three distinct clocks, three distinct network paths.
The relay is a **separate process** from the coordinator (a different box than
two of the three jurors), and its log — not the jurors' claims — is what the
coordinator verifies against.

`baospace` is deliberately not a juror: a "distributed" run that includes the
coordinator's own machine as a participant proves less. It coordinates only.

---

## 2. Roster shape: bond reference (carried now, verified later)

> **Round 53 update:** the reference is no longer carry-only. With
> `BAO_COURT_BOND_CHECK_CMD` set, the ceremony PROVES each juror's bond before
> the DKG and excludes/refuses an unproven one (`ROSTER_BELOW_THRESHOLD`).
> Contract, enforcement point, artifacts and the live runs:
> `docs/MULTI_PROCESS_CEREMONY.md` § "The bond gate". The text below describes
> the original carry-only round (still the default when the variable is unset).

Operator direction: the ceremony roster becomes stake-backed in a later round,
with **Liquid testnet first**. This round makes the shape and the pass-through
real, and records it, but does **not** verify anything.

```jsonc
// roster file, scp'd to every box (public material only — no secrets)
[
  {
    "idx": 1,
    "pubkey": "47753e6b9936469cc1dcff7ae0e743069b731fab864e9d0db64b47fad62f30b0",
    "bond": { "rail": "none", "network": "testnet", "proofRef": null }
  },
  …
]
```

Type and validator: `bondVerification.ts` → `CourtBondRef`, exported from the
package root.

| field | values | this round |
|---|---|---|
| `rail` | `liquid` \| `lightning` \| `onchain` \| `cashu` \| `none` | `none` for every juror |
| `network` | `testnet` \| `signet-public` \| `private-signet` | `testnet` (the eventual bonds' network) |
| `proofRef` | rail-specific proof reference, `null` when unclaimed | `null` |

Pass-through proof: the juror parses its roster entry with
`parseCourtBondRef` (unknown rail/network is an **error**, never silently
"no bond"), carries the reference in its `REPORT` line on the wire, and the
driver asserts each report echoes the roster entry verbatim —
`every reporting juror carried its roster bond reference through the ceremony
verbatim` (PASS in all three runs). Each run artifact records the reference per
juror with `bondVerified: false`.

**The bond reference is a claim, not a bond.** Nothing in this round treats
`rail:"none"` as satisfied stake, and no key was gated on it.

### Terminology and evidence hierarchy (operator decision)

- The network historically called "demo" is **private signet**
  (`private-signet`) in every human-readable string, doc and field value written
  by this change. Code identifiers and environment names are unchanged.
- **Evidence hierarchy: public testnet4 / signet-public outranks private
  signet.** That is why the roster's default bond network is `testnet`, not
  `private-signet`, and why the bond plan (not the transport) is what points at
  the publicly verifiable chain.

### Which network were the relay and jurors on?

The relay and the jurors are **plain hosts** — the transport is HTTPS/HTTP over
the public internet, not a chain. The network question is where the *bonds* will
live, not where the ceremony ran: bonds plan on **Liquid testnet**
(`rail:"liquid"`, `network:"testnet"`) first, and the same topology could be
re-run on hosts whose bonds are public-testnet-verifiable without changing a
line of the ceremony. This round claims no bond on any network.

---

## 3. Exact commands

### 3.1 Node on `bao-testnet` (least invasive: static tarball, no apt, no root package changes)

The box had no Node at all. Ubuntu 26's `nodejs` package is 22.22.1 but
installing a distro package mutates a live host; a static tarball under `/opt`
is reversible with `rm -rf`.

```bash
ssh bao-testnet '
  curl -fsSL -o /tmp/node-v22.22.0-linux-x64.tar.xz \
    https://nodejs.org/dist/v22.22.0/node-v22.22.0-linux-x64.tar.xz
  sudo mkdir -p /opt/bao-court-node
  sudo tar -xJf /tmp/node-v22.22.0-linux-x64.tar.xz -C /opt/bao-court-node --strip-components=1
  /opt/bao-court-node/bin/node -v      # v22.22.0
  rm -f /tmp/node-v22.22.0-linux-x64.tar.xz
'
# 205 MB in /opt/bao-court-node, no system package touched, no PATH change.
# The driver hard-codes this path for bao-testnet: `nodeFor('bao-testnet')`.
```

### 3.2 Inbound port for the relay (temporary, source-restricted, removed after)

`vps16gb` runs ufw with only 22/tcp open. The relay port was opened **only for
the three participating source addresses**, for the duration of the runs:

```bash
for ip in 185.238.221.69 142.132.167.103 162.35.242.99; do   # baospace, bao8gb, bao-testnet
  sudo ufw allow from $ip to any port 18471 proto tcp comment "bao-court-distributed-ceremony TEMP"
done
# …runs…
for ip in 185.238.221.69 142.132.167.103 162.35.242.99; do
  sudo ufw delete allow from $ip to any port 18471 proto tcp
done
```

No other port, host or service was touched; nothing was restarted.

### 3.3 The run

```bash
# everything: happy k=2, happy k=3 (all-of-N), then kill-mid-signing
npx tsx scripts/court/distributed-ceremony.mjs --scenario=all
# narrow forms
npx tsx scripts/court/distributed-ceremony.mjs --scenario=happy
npx tsx scripts/court/distributed-ceremony.mjs --scenario=kill --threshold=3

# a single box, to debug plumbing (degenerate: not evidence of distribution)
npx tsx scripts/court/distributed-ceremony.mjs --boxes=vps16gb --jurors=1
```

Configuration knobs: `--boxes=`, `--relay-box=`, `--port=`, `--jurors=`,
`--threshold=`, `--bond-rail=`, `--bond-network=`, `--bond-proof-ref=`,
`--poll-ms=`, `--dkg-deadline-ms=`, `--sign-deadline-ms=`,
`--kill-reveal-delay-ms=`, `--keep` (leave the boxes' run dirs for debugging).

### 3.4 What the driver does with the boxes

1. `esbuild` bundles `scripts/court/juror-child.ts` → one 429 KiB `juror.mjs`
   (no `tsx`, no `node_modules`, no repo checkout on any box).
2. scp's `juror.mjs`, `run-juror.sh`, a 0600 bearer token, and a public roster
   to each box (`/tmp/bao-court-dist/<runId>/`, `chmod 700`).
3. **Phase 1 — identities are generated ON each box:**
   `node juror.mjs --identity-only --identity-file=…` → the box generates a
   secp256k1 key with its own CSPRNG, writes it `0600`, and prints only
   `IDENTITY <x-only pubkey>`. The coordinator never holds, receives or
   transmits a juror secret; the roster goes back out as public keys.
4. **Phase 2 — launch:** one `sh run-juror.sh` per box, fire-and-forget, all
   within milliseconds of each other (parallel launch; a sequential launch cost
   a full ssh round trip per box and opened a false "missing participant").
5. **Relay:** `scripts/court/relay-server.mjs` on `vps16gb`, high port, bearer
   token from a 0600 file, hard `--max-records` cap, its own pid file, its own
   timing log.
6. **Verification (coordinator):** fetch `GET /log`, re-parse the DKG
   commitments with the production parser, sum the constant commitments to
   re-derive the group key, and call `verifyFinalSignature` on the aggregate.
   It never trusts a juror's self-report.
7. **Teardown:** kill the relay, `rm -rf` the run dir on every box.

---

## 4. Run A — N = 3, threshold k = 2 (quorum survives one absence)

```
[happy-n3-k2] N=3 k=2 relay=vps16gb (http://46.225.208.172:18471)
  PASS  the coordinator reaches the relay over the public network
  PASS  the answering relay is the process this run started, with an empty log
  PASS  the relay refuses an unauthenticated observer (bearer token is enforced)
  PASS  every juror runs on a DISTINCT box
  PASS  every identity was generated ON its own box and is distinct
  PASS  every box accepted the juror launcher
  PASS  every juror process terminated
  PASS  every reporting juror carried its roster bond reference verbatim
  PASS  every juror reported an outcome
  PASS  every juror completed DKG + signing
  PASS  all boxes independently computed the SAME group key
  PASS  all boxes aggregated the SAME signature
  PASS  the coordinator re-derives the group key from the relay's own log
  PASS  the coordinator verifies the FROST signature against THAT key
  PASS  the relay saw exactly one DKG commitment per juror (no equivocation)
  PASS  every juror's own wire log shows a reveal from every peer
  PASS  the relay stayed under its hard record cap and refused no ceremony traffic
  PASS  the only 401 the relay issued was the coordinator's own unauthenticated probe
  PASS  every juror polled the relay and was served the same honest view
  PASS  exactly one aggregate signature reached the relay's `report` records
```

**Group key (x-only, public):**
`38ef7f44bbdb8943d6b1d374c892d6275d0d3e1cfb2b5ed88d09d658832dc11a`
**Fingerprint:** `sha256(38ef7f44bbdb8943…)[0:16] = 43b71d68cfa69ce6`
**Signed message:** `c5bf2d8981f805913c8095e71b59e9ec2c045c002029b2f0f30ec4584a2a4447`
**Aggregate signature (BIP-340, public):**
`86629cadcd2ce0f49b386e171f5c60cb4cf4c25d1d86cf9b979fb88273647cda135369885088513f186cac555d40d86aaf0f928f16f4b5d1a8abdca1463e62dd`

**Verification line** (coordinator, from the relay's log only):
`verifyFinalSignature(38ef7f44…c11a, c5bf2d89…4447, 86629cad…62dd) -> true`.
All three boxes independently reported the same key and the same signature.

| idx | box | wall (measured on the box) | publish RTT p50 / p95 | poll RTT p50 | relay records |
|---|---|---|---|---|---|
| 1 | vps16gb (relay host) | 1322 ms | 1.69 / 14.75 ms | 0.90 ms | — |
| 2 | bao8gb | 1346 ms | 1.87 / 37.69 ms | 1.19 ms | — |
| 3 | bao-testnet | 1516 ms | 20.80 / 69.14 ms | 14.45 ms | — |
| — | total (coordinator) | **1936 ms** | — | — | 18 |

---

## 5. Run B — N = 3, threshold k = 3 (all-of-N)

Same topology, same code, `--threshold=3`. Every assertion above passes again.

**Group key:** `16c16683182c118a1ec5463ba06337ec1dd71ad82ac8d25416fbe1aebd3a0049`
**Fingerprint:** `sha256(16c16683182c118a…)[0:16] = b66e84a80d6de3cc`
**Aggregate signature:**
`cf38bdd723cdf5a064dddbbc54195aaae6a3ca0b0b54207956920ab182a3fa2dfc8f0d48d1bf98ec964c12ff70dff0cc913a5c37efc5ea45b8f97c2b6d1efac9`
**Verification:** `true` (same verifier, same key derivation from the receive
log; message identical to Run A because the attestation message does not depend
on the juror set — the *key* does).

Walls: vps16gb 1535 ms, bao8gb 1441 ms, bao-testnet 1556 ms; total **3699 ms**,
18 relay records.

---

## 6. Run C — kill one juror mid-signing, over ssh

Fault: **juror 2 (`bao8gb`) is SIGKILLed the moment its `frost-commit` reaches
the relay** — i.e. after it committed and before it revealed. The coordinator
watches the relay's receive log and delivers the kill from a *different box*
(`baospace`) over ssh:

```
killed juror 2 on bao8gb (pid 1483469) right after its frost-commit (seq 11)
```

The kill window is the honest commit→reveal interval, which on a healthy juror
is about **one poll tick (~20 ms)** — shorter than an out-of-band SIGKILL can be
delivered over ssh (~40–80 ms). The kill run therefore stretches *that same
window* to 450 ms with `--reveal-delay-ms` (`killRevealDelayMs`, 450 ms
default). It does not change what is tested — the receive-side reveal gate is
untouched — it only makes the fault deliverable from another machine. The run
asserts the kill actually landed in that window (`observedPhase:
"frost-commit"`, victim's reveal never on the wire).

Result — **fail closed, typed classification, no signature anywhere:**

| assertion | result |
|---|---|
| the victim was killed after its FROST commitment reached the relay | PASS |
| the victim emitted no REPORT (it died mid-signing) | PASS |
| every survivor failed closed with `SIGN_MISSING_REVEAL` | PASS (jurors 1 and 3) |
| NO survivor emitted a signature (no partial, no aggregate) | PASS |
| the relay never carried a reveal from the victim | PASS (`frost-reveal` from 1, 3 only) |
| no aggregate leaked onto the wire (`report` payloads carry no signature) | PASS |
| survivors still agree on the group key (DKG had completed) | PASS |
| the coordinator's recomputed group key matches the survivors' | PASS |

Group key of the aborted attempt (public, never used to sign anything):
`aae2c8d26350e0f77ead6371db87d54092adb5b9a6a3d284a43e70f284d6a51f`
fingerprint `sha256(aae2c8d26350e0f7…)[0:16] = a6e5bbc4b840abb4`.

Survivor disclosure (`REPORT` on the wire):

```json
{"round":1,"ok":false,"classification":"SIGN_MISSING_REVEAL","blamedIdx":2,
 "bond":{"rail":"none","network":"testnet","proofRef":null},
 "groupPubkeyXOnly":"aae2c8d2…a51f",
 "disclosure":{"committed":[1,2,3],"revealed":[1,3],"missingCommits":[],
               "missingReveals":[2],"deferredIngested":0,"duplicatesSeen":0}}
```

Relay phase census for the aborted run: `dkg-commit 3, dkg-share 6,
frost-commit 3, frost-reveal 2, report 2` — the missing `frost-reveal` is
juror 2's, and there are only two `report` records: the survivors'. No
signature was produced, so none could leak. Survivor walls 6891 ms and
7195 ms (they waited out the 6 s signing deadline before classifying, as the
protocol requires); total 7849 ms.

`blamedIdx` is **diagnostic only, never slashing evidence**: it names the
lowest roster index this process did not hear from in the failed phase.

---

## 7. Real latency, measured — versus the loopback harness

Nothing here is modelled. Three independent measurements per run:

- **client-side RTT** — `performance.now()` around each `fetch` in the juror
  process (round trip + relay handling);
- **relay handling** — the relay times its own POST/GET work (`hrtime`);
- **arrival gap** — spacing between consecutive records at the relay, i.e. what
  the network + jurors actually produced.

Relay handling was **0.01–0.14 ms at p95** in every run, so essentially all of
the client-side RTT is the network: subtracting it changes nothing at two
decimal places. Network RTT therefore is:

| link | publish RTT p50 | publish p95 | poll RTT p50 | one-way clock delta (p50) |
|---|---|---|---|---|
| vps16gb → vps16gb (same box) | 1.69 ms | 14.75 ms | 0.90 ms | 1 ms |
| bao8gb → vps16gb | 1.87 ms | 37.69 ms | 1.19 ms | 1 ms |
| bao-testnet → vps16gb | 20.80 ms | 69.14 ms | 14.45 ms | 10 ms |
| loopback harness (all three) | < 1 ms | — | < 1 ms | ~0 ms |

(`serverDeltaMs` = client-now − relay-`serverTime` measured after the response
arrived: the response leg plus clock offset. The boxes are not NTP-aligned to
each other, so this is an offset-inclusive figure, not a one-way latency. It is
reported for completeness and never used as an RTT.)

**Wall clock, distributed vs loopback (N = 3):**

| run | coordinator wall | slowest box wall | relay records |
|---|---|---|---|
| distributed k=2 | **1936 ms** | 1516 ms | 18 |
| distributed k=3 | **3699 ms** | 1556 ms | 18 |
| kill (k=3) | 7849 ms | 7195 ms | 16 |
| loopback k=2 (median of 3: 6910 / 4385 / 6266) | **6266 ms** | n/a | 18 |

The distributed run is *faster in wall clock* than the loopback harness for one
dull reason: the harness spawns `tsx` per juror (TypeScript transpile ≈ 1 s
each) while the distributed boxes run a pre-bundled `juror.mjs`. The honest
reading is not "distributed is faster"; it is **the ceremony itself costs
~1.3–1.6 s per box across the network, and the loopback harness's 4.4–6.9 s is
mostly process startup and its deterministic 150 ms gaps, not ceremony work.**
Inter-message arrival gaps at the relay were p50 ≈ 48 ms / p95 ≈ 240 ms
distributed, versus the harness's modelled 150 ms commitment→shares gap and
≤ 41 ms jitter.

---

## 8. What the distributed run found that loopback could not

**A real bug, found by real timing.** The juror's receive loop is
phase-segregated: it polls for DKG traffic until it can compute the key, then
polls for signing traffic. Over a real network, a peer that finishes DKG first
publishes its FROST commitment *while a slower peer is still in DKG* — that
peer's cursor had already advanced past the record and the record was
**discarded**, so an honest, healthy peer looked like it never committed
(`SIGN_MISSING_PARTICIPANT` for two of three jurors, reproduced on the first
three-box k=2 attempt).

On loopback the window is a few hundred microseconds and never fired; across
boxes (25–70 ms RTTs, one box 2 000 km further) it fired immediately. Fix:
out-of-phase `frost-commit`/`frost-reveal` records that arrive during DKG are
**deferred and ingested when the signing phase starts** (reported as
`disclosure.deferredIngested`), instead of being dropped. The loopback suite
(happy path, kill, replay, Byzantine-relay matrix) stays green — the change is
strictly "do not throw away a signed message you were going to need".

This is exactly the class of defect single-machine harnesses cannot see, and it
is the strongest argument for the topology: not that the crypto is right (the
loopback suite shows that), but that the *transport/timing* assumptions embedded
in the harness's own receive loop were wrong.

---

## 9. What this proves / what it still does not

**Proves**

1. The production pipeline (`IndependentDkgSession` → `IndependentSigningSession`,
   real parsers, real FROST aggregation) completes across **three separate
   kernels, clocks and network paths**, with a relay on a fourth process and
   coordinator-hosted nowhere near two of the jurors.
2. Node compatibility across v20.20.0 and v22.22.0, from a single-file bundle
   with no `node_modules` on any box.
3. The coordinator independently **re-derives the group key from the relay's own
   receive log** and **verifies the FROST signature** — it does not trust any
   juror's self-report, and no two jurors could have colluded to fake it.
4. **Key separation is real**: each box generated its own key locally (0600
   file, never transmitted); only x-only public keys and a public roster
   crossed the network. No secret was ever in an argv, a log, or an artifact.
5. A juror dying mid-signing (SIGKILL from a third machine) makes the survivors
   **fail closed with a typed classification and emit nothing** — no partial
   signature, no aggregate, nothing leaking onto the wire.
6. Real numbers, not a model: 1.7–21 ms publish RTT depending on the link,
   ~1.3–1.6 s per box, 1.9 s / 3.7 s total.

**Still does not prove**

1. **Three boxes is not a network adversary model.** Links were honest: no
   packet loss, no partition, no reordering beyond the relay's own protocol, no
   clock skew attack, no eclipse. (The loopback harness's Byzantine-relay matrix
   covers the *policy* attacks; it cannot make them real.)
2. **One operator owns all four machines.** There is no independent
   jurisdictional or administrative separation, and the relay operator could in
   principle be the coordinator.
3. **No real stake.** Every juror's bond reference is `rail:"none"`. Nothing was
   at risk, nothing was slashed, and no bond was verified — the roster *shape*
   exists, the economics do not.
4. **Keys live on disk** (0600 file per box), not in an HSM, a FROST device, or
   a threshold-secured enclave. Share custody for the run duration is process
   memory.
5. **k = 2 across three boxes is quorum, not crash-tolerance under partition.**
   The protocol's current DKG requires the full certified roster; the kill run
   shows the *signing* gate failing closed, not a protocol that heals.
6. **Latency is one geography.** Two boxes are in the same datacentre region and
   one is further away; this says nothing about intercontinental or
   adversarial-network behaviour.
7. **Marmot/NIP-59 transport, DCTL witnesses, escrow, and settlement are not
   exercised here** — this run is the ceremony's key-generation and signing
   path only.

---

## 10. Cleanup (done)

- relay processes killed on `vps16gb` (SIGTERM, then verified with `pgrep`);
- every juror process gone on all three boxes (verified with `pgrep`);
- `/tmp/bao-court-dist/` removed on all three boxes (bundles, launcher, roster,
  bearer token, identity files, timings, logs);
- the coordinator's local work dir (with its 0600 token and per-box artefacts)
  removed at the end of the driver run;
- the three temporary `ufw` rules for port 18471 deleted;
- no service on any box was restarted or reconfigured;
- `/opt/bao-court-node` on `bao-testnet` is **left in place** (it is an
  installation, not a run artefact — the runbook in §3.1 is how to remove it:
  `sudo rm -rf /opt/bao-court-node`).

Verification after the runs:

```bash
for h in vps16gb bao8gb bao-testnet; do
  ssh $h 'pgrep -af "relay-server[.]mjs|bao-court-dist" | grep -v pgrep; ls -d /tmp/bao-court-dist 2>/dev/null'
done      # → no output from any box
ssh vps16gb 'sudo ufw status | grep 18471'   # → no rule
```

---

## 11. Files

| file | what it is |
|---|---|
| `scripts/court/relay-server.mjs` | standalone relay: same JSON protocol as the harness, bearer token from a 0600 file, hard record cap, own timings, `GET /log` for the coordinator's audit |
| `scripts/court/juror-child.ts` | unchanged loopback behaviour + `--relay-url`, `--token-file`, `--identity-file`, `--roster-file`, `--timings-file`, `--identity-only`, `--reveal-delay-ms`, and the deferred out-of-phase ingest (§8) |
| `scripts/court/distributed-ceremony.mjs` | the driver: bundle, ship, launch over ssh, kill over ssh, verify, measure, tear down |
| `bondVerification.ts` | `CourtBondRef` / `parseCourtBondRef` / `UNBONDED` — the roster bond reference |
| `docs/benchmarks/distributed-ceremony/*.json` | run artifacts (public material only: public keys, group keys, signatures, timings) |

## 12. Reproduce

```bash
git clone https://github.com/baocommunity/bao-court && cd bao-court
npm ci
# 1. Node on the box that has none (§3.1)
# 2. open the relay port for the participating addresses (§3.2)
npx tsx scripts/court/distributed-ceremony.mjs --scenario=all
# 3. close the port (§3.2)
```

Assumes `ssh <alias>` works with `BatchMode=yes` for `vps16gb`, `bao8gb`,
`bao-testnet` (and `baospace` is the machine you are on). If a box is
unavailable the driver refuses to run rather than silently shrinking the
topology: run it with the boxes you have and say so in the report.

---

## 13. How this change was verified (and the honest caveat)

**The loopback contract is unchanged.** `juror-child.ts` keeps `--relay` as its
primary option, sends no `Authorization` header when no token file is given, and
only buffers out-of-phase records it previously discarded. A/B on the same box,
both trees, all with `--deadline-ms=25000`:

| scenario | `origin/main` | this branch |
|---|---|---|
| `--jurors=3` (happy, k=2) | PASS | PASS |
| `--chaos=kill` | PASS | PASS |
| `--mode=reorder` | PASS | PASS |
| `--mode=replay` | PASS | PASS |
| `--mode=fork` | PASS | PASS |

**Full suite:** `npm test` on the shared build box reported **1966 passed / 6
failed** (plus 1 skipped) with `--testTimeout=60000`. Every failure is a
contention timeout, not an assertion: three `r33` cases and one `r30` case whose
*harness-internal* phase deadline is 10 s while three `tsx` child processes were
starved on a 16-core box at **load average 60–80** (other agents' builds), plus
`propertiesBatch` (134 s) and one model-checking case (816 s) that blew the
60 s test timeout. The same files fail on a pristine `origin/main` worktree
under the same load (2 of 2 ceremony files failed there; 1 of 2 on this branch,
a different one — the subsets move with the load, which is what contention
looks like), and all of them pass with realistic deadlines. `npm run
typecheck`, `typecheck:scripts` and `typecheck:tests` are clean.

Recorded plainly because "the suite is green" is a claim about a machine, not
about this diff: on a quiet runner the numbers are 1953/90 at v0.15.2.
