# BAO Court — Symposium Figure Inventory

**Version:** round 16 (presentation artifacts) · tracks `@bao/court` v0.10.2
**Companion:** [`OUTLINE.md`](OUTLINE.md) (slide↔figure mapping) · [`DEMO_SCRIPT.md`](DEMO_SCRIPT.md)

Six figures, F1–F6. All are ASCII/markdown-renderable — no image assets, no
Mermaid, no external tooling; every figure prints in a monospace code block
and each carries its source-of-truth pointer (what to update if the protocol
changes).

---

## F1 — The ceremony pipeline *(polished from README §1)*

Four certified stages; any contradiction **aborts the attempt**, never
degrades it.

```
┌──────────────┐   ┌─────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│  SELECTION   │   │        DKG          │   │        VOTE          │   │       SIGNING        │
│ selection.ts │──▶│ IndependentDkgSession│──▶│  CourtVoteMachine    │──▶│ CourtSigningMachine  │
└──────────────┘   └─────────────────────┘   └──────────────────────┘   └──────────────────────┘
 roster + backups    Pedersen/PedPop DKG      commit ▶ reveal ▶ tally    FROST nonce-commit ▶
 seed = H(disputeId  suite pedpop-v1-        one commit / one reveal    partial sigs ▶ aggregate
 ‖ blockHash)        experimental            per roster index           ▶ kind-89 / 39007 event
 publicly            NO party ever holds     frozen verdict hash        ONE ordinary BIP-340
 recomputable        the group secret        (BAO-Court/Verdict/v1)     signature under P_dispute
      │                    │                        │                        │
      ▼                    ▼                        ▼                        ▼
 verifyJurySelection  possession-bound        ties break lex-          aggregation needs
 (anyone recomputes   complaints (m+1 ≤ t)    canonically; invalid     ≥ threshold partials;
  the draw)           disqualification        reveals become slash     nonce equivocation
                      ABORTS the attempt      evidence, never throws   ABORTS with blame
```

**Under the pipeline — the settlement seam (attestation, never custody):**

```
   FROST attestation (kind 89 / 39007)          winners claim with their OWN keys
 ┌────────────────────────────────────┐   ┌────────────────────────────────────┐
 │  jurors ATTEST ── they cannot spend │   │  Path A: primary attestation + winner sig   │
 │  oracle key, not a spending key     │   │  Path B: FROST attestation  + winner sig    │
 └────────────────────────────────────┘   │  Path C: timelock refund (censorship stall) │
                                          └────────────────────────────────────┘
```

*Source of truth:* README §1; paper §3.2–3.3, §5.

---

## F2 — Universal-confirmation state machine

Phases are the machine's own `CourtConfirmationPhase` literals
(`confirmationMachineTypes.ts`); edges are events. Terminal states: ▣.

```
                         create (roster ≥ 3, fail-closed)
                                    │
                                    ▼
                            ┌──────────────┐   close_confirms   ┌───────────────┐
                            │ confirm_open │───────────────────▶│ confirm_closed │
                            └──────────────┘                    └───────┬───────┘
                                                                        │ open_challenge_window
                                                                        ▼
                                                          ┌───────────────────────────┐
                    NO challenge (bond-witnessed)         │     challenge_window      │
              ┌───────────────────────────────────────────┴──────────────┬────────────┐
              │                                                          │ challenge  │
              ▼                                                          ▼            │
      ┌────────────────┐                                       ┌──────────────────┐    │
      │ fee_settlement │◀──────────────────────────────────────┤  ladder_pending  │    │
      └───────┬────────┘              ▲                        └────────┬─────────┘    │
              │                       │              open_ladder_round (panel   │
              │ finalize              │              may EXPAND: r1=15 r2=45     │
              ▼                       │              r3=135 — ×3 per round)      │
      ┌────────────────┐   concede    │                                 ▼        │
      │      final  ▣  │◀─────────────┤                       ┌──────────────────┐
      └────────────────┘              │                       │ ladder_vote_open │
              ▲                       │                       └────────┬─────────┘
              │                       │              close_ladder_votes │
              │  escalate (host-driven, explicit —             ▼        │
              │  the machine never auto-escalates)   ┌──────────────────┐
              └──────────────────────────────────────┤ladder_vote_closed│
                                                     └────────┬─────────┘
                                              resolve_round   │
                              (ledger barriers re-verify      ▼
                               confirmation + outcome      ┌────────────────┐
                               ledgers BEFORE value moves) │ round_resolved │
                                                           └───┬────────┬───┘
                                                 escalate ─────┘        └─────── concede
                                                 (next round,                            │
                                                  max ≤ 5)                               ▼
                                                                          (back to ladder_pending
                                                                           / fee_settlement)

   terminal failures from ANY non-terminal phase:  expired ▣   aborted ▣
   (every awaiting-input phase carries a tick deadline — the case expires,
    it never hangs; Path-C refund bounds the damage)
```

**Clawback rules (append-only, idempotent, flag history is NOT a verdict input):**

```
  overturned_confirmation : round overturns the proposal ─▶ every confirming juror flagged (once)
  round_flip              : round r winner ≠ round r−1 ───▶ round r−1's MAJORITY flagged
  finality                : verdict = LAST resolved round's winner, under hashCourtVerdict
```

*Source of truth:* `confirmationMachineTypes.ts` (phase set), README §6,
paper §6.1–6.3, INV-CONF-1…36 in FORMAL_INVARIANTS.md.

---

## F3 — Batch-attestation Merkle structure (kind 39018)

One cohort signature certifies an entire epoch's verdict cohort
(RFC-6962 tree, ≤10,000 verdicts; here n=7 for legibility).

```
                        ┌─────────────────────────────────────────────┐
                        │  SIGNED MANIFEST  (BAO-Court/BatchManifest/v1)│
                        │  {epoch, cohort, batchIndex, count = 7,      │
                        │   root, finalizedAt}                         │
                        │  ◀── ONE FROST threshold Schnorr signature   │
                        └───────────────────────┬─────────────────────┘
                                                │ covers
                                                ▼
   level 2:                          ┌───────────ROOT───────────┐
                                     │      BatchNode/v1        │
                                     └──────┬──────────┬────────┘
   level 1:                    ┌──────────┴───┐  ┌───┴──────────┐
                               │  BatchNode/v1│  │  BatchNode/v1│      ← RFC-6962 unbalanced
                               └──┬────────┬──┘  └──┬──────┬────┘        split k = 2^⌊log₂(n−1)⌋
   level 0 (leaves):        ┌──┴──┐ ┌───┴┐ ┌─────┴┐ ┌───┐ ┌┴────┐ ┌──┴──┐
                            │ L0  │ │ L1 │ │ L2   │ │L3 │ │ L4  │ │ L5,6│
                            └─────┘ └────┘ └──────┘ └───┘ └─────┘ └─────┘
   leaf_i = H(BAO-Court/BatchLeaf/v1 ‖ hashCourtVerdict_i)     (sorted, duplicates rejected)

   CASE INCLUSION PROOF (per case, O(log n)):
   verifyCaseInBatch(case i) = recompute leaf_i ──fold──▶ root
        ◀── the ~14-node Merkle fold is negligible; ONE Schnorr verify (~1.3 ms) dominates
        ⇒ per-case verification cost is FLAT from 10 to 10,000 leaves
   in-band finality binding (v2): epochId, tier, threshold, signerSetRoot,
   batchMerkleRoot are INSIDE the signed message — a stale v1 artifact can
   never satisfy v2 policy (downgrade refused, INV-VAL-13)
```

*Source of truth:* `batchAttestation.ts`, paper §7.2–7.3, INV-BATCH-1…16.

---

## F4 — The escalation ladder: rounds, growth, and the cost curve

Panel growth is ×3 per round (host-side reference sizes); a bond-witnessed
challenge is re-wagered each round and forfeited into the pool when the
dispute is rejected. Cumulative juror-round cost vs the never-challenged base
case: Σ 3^k = (3^(r+1) − 1)/2.

```
round      panel size      cumulative cost        attacker's repeated-
           (×3 growth)     (× base case)          challenge burden
─────────────────────────────────────────────────────────────────────
  base      1×  (≈5)          1×              confirmations: paid by fee pool
  r1        3×  (15)          4×   ◀──        first challenge: bond B at risk
  r2        9×  (45)         13×              escalate: bond re-wagered
  r3       27×  (135)         40×
  r4       81×  (405)        121×
  r5      243×  (1215)       364×   ◀── maxLadderRounds bound (1..5)

cost
 400× ┤                                                    ●
      │
 300× ┤
      │                                          ●
 200× ┤
      │
 100× ┤                                  ●
      │
  40× ┤                          ●
      │
      │                  ●
  10× ┤          ●
   4× ┤  ●
    1× ┼──●────────────────────────────────────────────────────▶ rounds
       0   1   2   3   4   5
       cumulative juror-round cost, ×3^k growth — SUPERLINEAR in r
```

**The design point:** bad-faith challenge spam is priced *superlinearly* —
each escalation forces the challenger's bond to be re-wagered while the
panel (and the evidence burden) triples; a rejected challenge forfeits the
bond into the slashing pool, so sustained griefing costs 4× → 13× → 40× →
121× → 364× the base confirmation cost. Honest challengers escalate only
when they are right — and the `round_flip` clawback flags the losing
majority, not the winner.

**Honesty note (the numbers' provenance):** the ×3 panel growth
(r1=15, r2=45, r3=135), the ≤5-round cap, bond forfeiture on rejection, and
both clawback rules are implemented and pinned (CHANGELOG v0.9.0;
ESCROW-SLASHING §4); the 1×→364× *curve* is the cost model those parameters
imply. The bribe-equilibrium reading of it is open — PO-1 (THREAT_MODEL §6).

*Source of truth:* CHANGELOG v0.9.0 (multi-round ladder), paper §6.2,
ESCROW-SLASHING §4, THREAT_MODEL §6 PO-1.

---

## F5 — The trust-boundary / MUST-pin table (P1–P12)

A valid signature proves only that **some** key signed the message. Every
consumer boundary below, formalized; every unpinned consequence is reproduced
by a named adversarial test.

```
 CONSUMER DUTY                    WHAT IS TRUSTED ABSENT THE PIN      WHAT HAPPENS UNPINNED
 ───────────────────────────────  ─────────────────────────────────   ─────────────────────────────────────
 P1  expectedGroupPubkey    ★     ANY public key                      attacker re-signs SAME tags with
                            │                                         ELEVATED tier/threshold → full A1/A2
                            ▼
 P2  expectedEpoch                "some epoch"                        epoch-1 attestation passes epoch-2 policy
 P3  expectedBatchMerkleRoot      batch root as presented             missing/swapped batch tag satisfies policy
 P4  expectedSignerSetRoot        signers tag as presented            smaller/different signer set rides along
 P5  minTier / minThreshold       policy as claimed                   self-asserted tier accepted (compounds P1)
 P6  batch validated with SAME    batch self-consistency only         epoch confusion across the chain
     expectedEpoch (SEQUENCE-1)
 P7  expectedCohort / finalizedAt manifest fields as presented        self-selected manifest timestamps itself
 P8  expectedDispute/Market/      event's own tags                    attestation transplanted across disputes;
     outcomes/publishers                                              non-ballot outcome rides in
 P9  empty pin ('') is typed-     unset config silently disabling     (CLOSED v0.9.2, F-2) — was: empty pin
     INVALID, never "no pin"      the pin                             silently disarmed P1–P8
 P10 no v1 downgrade under v2     format ambiguity                    (CLOSED, INV-VAL-13) — stale-artifact replay
     policy                                                           of round-0/old-epoch artifacts
 P11 host: bond witness-vs-UTXO   witness-hash binding only           challenge over a spent/nonexistent UTXO
     check BEFORE dispatch                                            enters the ladder (host-side boundary)
 P12 host: dedup by verdictHash   batch membership scope              silent double-count across epochs' batches
     BEFORE reputation                                                (convention, INV-BATCH-16)

 ★ P1 is the load-bearing pin: EVERY consumer deriving finality, tier policy,
   reputation, or settlement MUST pin the empaneled cohort's FROST key.

        DESIGN RULE (paper §587): caller-pins-not-the-event — the event cannot
        carry its own trust context, because the ATTACKER controls re-publication.
```

*Source of truth:* THREAT_MODEL §5 (P1–P12 with full rows),
`__tests__/adversarialCrossModule.test.ts` (SEQUENCE-1/3),
`__tests__/propertiesValidator.test.ts` (PV1–PV4).

---

## F6 — The audit program: ten rounds, one methodology

*(bonus figure — the slide-14 story in one line of dots)*

```
 round    surface                    shipped
 ────────────────────────────────────────────────────────────────────────────
 R1   ──  validator/finality + machine fuzz ── PR #36/#37 ── 8 findings (1 HIGH)
 R2   ──  cross-module (batch-root pin, restore barriers) ── PR #41 ── 3 fixed
 R3   ──  property sweep (570 generated cases) ── PR #44–46 ── 6 (mid-ladder
          dead end found by the sweep, fixed fail-closed)
 R4   ──  formal audit: 145 invariants from the guards ── PR #47/#48 ── F-1…F-12
          (3 substantive: clock ledgers, empty-pin, history barrier)
 R5   ──  exhaustive model check (3.1M states) ── PR #53/#58 (F7 repair)
 R6   ──  crypto-literature audit (FROST/Drijvers/RFC 9591/ChillDKG/
          CVE-2025-58359/RFC 6962) ── PR #49 ── 12 mechanisms
 R7   ──  differential parity + adversarial Nostr ── PR #52/#51 ── 3 real bugs
 R8   ──  performance: measured, byte-identical, refusals recorded ── PR #50/#54
 R9   ──  soak at 10k/day (virtual clock) ── host PRs #2293/#2295 ── found F6
 R10  ──  host-side mechanism audit (economic: ack farming, redelivery
          griefing, epoch replay) ── host PR #2294
      ──  + threat model formalization + claim cross-check ── PR #62/#63/#64
          (272 claims, 95.2% with executable proof, 0 dangling pointers)

      RESULT: ≈30 findings, 5 top-severity — every one fixed with a regression
      test or dispositioned in the Gap register. The audits never "expire":
      each round's repro is an always-on adversarial suite (582+ tests).
```

*Source of truth:* EVALUATION §3.1 (audit-record table), §3.4 (adversarial
suites as regression value), paper §11.5.
