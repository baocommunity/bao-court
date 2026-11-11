# Attributable signing — the session journal and the batch-signing duty

**Status:** normative for the attribution control; the journal **format and the
verifier are shipped** (`attribution.ts`, `@bao/court` v0.10.x); the log
**store, publication and gossip are v0.11 candidates** (§5). Proof:
[`docs/proofs/attribution.tex.md`](proofs/attribution.tex.md) (Theorem 6).
Invariants: **INV-ATTRIB-1..3** (`docs/FORMAL_INVARIANTS.md` §16). Threat
model: `docs/THREAT_MODEL.md` §4.1.

---

## 1. Why this exists

The FROST aggregate a court publishes is an ordinary BIP-340 Schnorr signature
`(R, s)` under the group key. It is indistinguishable from any other signature
under that key and names no signers (Theorem 6, Lemma 6.0). Two consequences:

1. **No attribution risk for a malicious signer.** A juror that contributes a
   partial to a valid-but-wrong attestation is invisible in the artifact every
   verifier sees. The threshold protects against *forgery by outsiders*; it
   gives no *forensic* answer to "which of the 5-of-9 jurors did this?".
2. **A batch signature covers up to 10 000 verdicts** (`batchAttestation.ts`,
   `MAX_BATCH_VERDICTS`), so a single careless or malicious contribution can
   certify a large set at once. The paper never said what a batch signer must
   verify before contributing; §4 makes that a normative duty.

The control is to publish the **session**, not just the signature: round-1
nonce commitments, round-2 partials, the signer set, the threshold, and the
aggregate — the evidence from which anyone can recompute and attribute
(Theorem 6). That record is append-only journaled, using the RFC 9162
(Certificate Transparency) log construction the CT analogy points at.

**Honest boundary:** this is a *detective* control. It does not prevent a
≥t collusion from producing a valid verdict (that is what a threshold signature
is, ADV-JUROR-≥t, PO-1); it makes the participating shares attributable after
the fact, which is what turns slashing/reputation from a policy claim into an
enforceable one.

---

## 2. The signing-session record

### 2.1 Fields

Built by `attribution.ts › buildSigningJournal({ message, groupPubkey,
threshold, signerSet, commitments, partials })`.

| Field | Type | Meaning | Check on verification |
|---|---|---|---|
| `version` | `1` | record version | must be `1` |
| `message` | 32-byte hex | signed digest (`buildAttestationMessage` / `…V2`) | recomputed from the attestation context by the consumer |
| `groupPubkey` | 33-byte compressed hex | group key **as used for aggregation** — the compressed form fixes the Y-parity the partials were computed under; its x-only projection must equal the pinned attestation key | `xOnly(groupPubkey) = pinned Q` |
| `threshold` | int ≥ 1 | `t` at signing time | signer count ≥ `t` |
| `signers[i].idx` | int | roster index | sorted, distinct, exactly one per partial |
| `signers[i].pubkey` | 33-byte hex | the signer's verification-share pubkey as published (`s_i.pubkey`) | **must equal the certified `verificationShares` entry** (P1) |
| `signers[i].binderPn` | 32/33-byte hex | round-1 binder nonce point `E_i` | on curve |
| `signers[i].hiddenPn` | 32/33-byte hex | round-1 hidden nonce point `D_i` | on curve |
| `partials[i].psig` | 32-byte hex | `s_i` | `s_i·G = R_i + c·λ_i·(π·Y_i)` |
| `aggregate.pubNonce` | 32-byte hex | `R` | `= xOnly(group_nonce(commitments))` |
| `aggregate.signature` | 64-byte hex | `R‖s` | `= combine(partials)` and BIP-340-valid under `Q` |

The record carries **public data only**. It must never include the secret nonce
fields (`binder_sn`/`hidden_sn`) — combining a published partial with its
secret nonce reveals the signer's share (`signing.ts:283-291`).

### 2.2 Example (illustrative — values truncated)

```json
{
  "version": 1,
  "message": "6f0c…9a",
  "groupPubkey": "02a1…7d",
  "threshold": 2,
  "signers": [
    { "idx": 2, "pubkey": "03be…11", "binderPn": "02c4…", "hiddenPn": "02f9…" },
    { "idx": 4, "pubkey": "02d7…08", "binderPn": "0381…", "hiddenPn": "02aa…" }
  ],
  "partials": [
    { "idx": 2, "psig": "9d31…c0" },
    { "idx": 4, "psig": "41ee…7b" }
  ],
  "aggregate": { "pubNonce": "77b0…3c", "signature": "77b0…3c6e…19" }
}
```

### 2.3 API and outcomes

```ts
const journal = buildSigningJournal({ message, groupPubkey, threshold, signerSet, commitments, partials });
const result  = verifyAggregateAttribution(journal, aggregate, pinnedGroupXOnly, dkg.verificationShares);
// { valid, attributed: [2, 4], failures: [], identityPinned: true, reconstructedSignature }
```

`buildSigningJournal` **recomputes** the aggregate from the partials, so a
record can never describe a signature its partials do not produce. Pass
exactly the signer subset that aggregated — commitments beyond the reveal set
change the FROST binding factors and make the record fail reconstruction (the
same contract as `aggregateAttestation`). The verifier
is fail-closed and never throws on tampered record data; each failure names a
code and, where local, the attributable `idx`:

| Failure code | Attributable to | Meaning |
|---|---|---|
| `GROUP_KEY_MISMATCH` | publisher | record key ≠ pinned key |
| `THRESHOLD` / `STRUCTURE` | publisher | < t signers; partial set ≠ signer set; missing partial |
| `SHARE_MISMATCH` | `idx` | published share key ≠ certified share (P1) |
| `PARTIAL_INVALID` | `idx` | `s_i` fails the share-verification identity |
| `R_MISMATCH` | publisher | `R` ≠ group nonce of the commitments (or `pubNonce` ≠ `sig[0:32]`) |
| `RECONSTRUCTION_MISMATCH` | publisher | partials do not sum to `s` |
| `AGGREGATE_INVALID` | publisher | `(R, s)` is not a Schnorr signature under `Q` |

`identityPinned` reports whether the caller supplied the certified DKG share
list. **Attribution is only as strong as that pin** (Lemma 6.3): without it a
fabricated journal can name a substitute share key and still look consistent.

---

## 3. The append-only journal (RFC 9162 construction)

The record above is one **entry** in a *Court Signing Journal* (CSJ). The log
makes entries tamper-evident and, crucially, makes *omission* detectable: a
host that quietly drops or rewrites a session changes every subsequent tree
head.

### 3.1 Entry and tree

```
log entry   E_i = ( seq = i, journal = J, duty?, publishedAtSec )
recordHash  H_i = hashSigningJournal(J)                     // BAO-Court/SigningJournal/v1
leaf        L_i = SHA-256( 0x00 ‖ H_i )                     // RFC 9162 leaf
node        N(l,r) = SHA-256( 0x01 ‖ l ‖ r )                // RFC 9162 internal
split       k = 2^floor(log2(n-1))                           // same shape as batchAttestation.ts
head        TH_n = ( treeSize = n, rootHash = MTH(L_0..L_{n-1}) )
```

The 0x00/0x01 tags and the RFC-6962 split are the same construction as the
batch attestation tree, so one verifying implementation covers both (INV-X-1
keeps the domains disjoint; the leaf preimage domain is `SigningJournal/v1`,
and the head-signature domain `SigningJournalHead/v1` is reserved for the
v0.11 log, §5.2).

### 3.2 Signed tree head

```
STH = ( treeSize, rootHash, timestampSec )
sig = BIP-340( hostKey, SHA-256( "BAO-Court/SigningJournalHead/v1" ‖ u32(treeSize) ‖ rootHash ‖ u64(timestampSec) ) )
```

A verifier that has `STH_n`:
- **inclusion:** for a claimed session, fold the audit path to `rootHash`
  (O(log n)) and confirm `hashSigningJournal(J)` is the leaf at `seq`;
- **consistency:** for `STH_m`, `m < n`, verify the RFC 9162 consistency proof
  — a rewritten or truncated prefix cannot produce one;
- **equivocation:** two STHs at the same `treeSize` with different roots, or
  two different leaf preimages for the same `(message, aggregate)` binding, are
  proof of a split view. Publication of heads (relay, site, juror gossip) is
  what makes this detectable; the log alone cannot see a fork.

### 3.3 The CT analogy, precisely

| Certificate Transparency | Court Signing Journal |
|---|---|
| CA issues a certificate | cohort signs an attestation |
| leaf = precert/cert | leaf = session journal record |
| SCT / inclusion proof | inclusion proof against `STH` |
| CT log operator (untrusted for integrity) | host (untrusted for integrity, A7) |
| monitors + gossip detect split logs | jurors/verifiers compare heads |
| misissuance is *detectable* | mis-signing is *attributable* |

The log operator being untrusted is the design point: the host already drives
the machines (`ADV-COORD`) and holds the release credential in v1. Logging does
not trust the host more; it makes the host's deletions and rewrites detectable,
and per-signer authentication (§3.4) makes signed entries non-repudiable.

### 3.4 Authentication (premise P2)

The journal must not be forgeable by the host or a relay:

- each juror's commitment and partial are published as NIP-01-signed Nostr
  events by the juror's own key in the existing ceremony (`courtSigningMachine`
  events are self-authenticating); the journal entry references those event ids;
- the log entry records `publisher` (the signing Nostr key) and, in the v0.11
  target, each participant appends its **own** entry, so no single party can
  rewrite the record;
- in the v0.10.x host-side journal (single publisher) the control is honest but
  weaker: it detects everyone except the host itself — the host's own
  misbehaviour remains covered only by the aggregate + event ids it cannot
  forge (it holds no shares).

---

## 4. The batch-signing duty (D-BATCH)

A kind-39018 batch attestation signs
`hashBatchManifest({ epoch, cohortPubkey, batchIndex, count, root, finalizedAtSec })`
and thereby certifies up to `MAX_BATCH_VERDICTS = 10 000` verdicts. Because
signing is attributable (Theorem 6), the duty is enforceable after the fact;
it must therefore be *stated* and *journaled*.

> **D-BATCH — what a signer MUST verify before contributing a partial to a
> batch root.**
>
> **D1 (cohort/epoch binding).** The manifest's `epoch`, `cohortPubkey`,
> `batchIndex` and `finalizedAtSec` match the cohort epoch the signer is
> currently signing (same epoch window, same cohort key as the pinned group
> key, `finalizedAtSec` within the epoch). Reject cross-epoch or cross-cohort
> manifests; never sign a bare root string instead of `hashBatchManifest(M)`.
>
> **D2 (count and shape).** `count = |H|` for the verdict-hash list `H` the
> signer was given; `1 ≤ count ≤ 10 000`; no duplicate hashes (`INV-BATCH-3`);
> every entry is 32-byte lowercase hex.
>
> **D3 (root recomputation — the load-bearing check).**
> `buildBatchMerkleTree(H).root = root` using the signer's **own** verdict
> hashes. A root received next to the manifest is not evidence; recomputation
> is. This is the check that makes "one signature, 10 000 verdicts" mean
> something: the signature certifies precisely the hashes the signer folded.
>
> **D4 (inclusion spot-check, recommended).** For at least its own case (or a
> random sample), verify `verifyCaseInBatch(H, idx)` against the final event —
> cheap, and it catches a manifest that is internally consistent but whose
> published proofs do not match.
>
> **D5 (duty record).** Append to its journal entry:
> `{ batchManifestHash, count, root, verifiedAtSec }`. The record is the
> evidence that the signer did D1–D3; its absence is itself an audit finding.

**Refusal is correct behaviour.** If D1–D3 fail, the signer MUST NOT contribute
a partial; the batch is refused (a liveness cost, not a safety one). The
protocol's error taxonomy already distinguishes malformed batch data
(`BATCH_ATTESTATION`); hosts should report the refusal with the failed check.

**What the duty buys.** With D-BATCH, an aggregate over a batch root is
attributable *and* informed: the signers can be asked which verdict set they
verified, and the journal answers. Without it, a signer can plausibly deny
having seen the verdict list — the exact accountability hole this round closes.

---

## 5. Deployment

### 5.1 Shipped today (v0.10.x)

- `attribution.ts`: `buildSigningJournal`, `verifyAggregateAttribution`,
  `hashSigningJournal`, typed results and failure codes; exported from the
  package root and as `@bao/court/attribution`.
- Tests: `__tests__/attribution.test.ts` (8 cases: positive, forged partial,
  missing partial, tampered aggregate, wrong signer set, identity pin, wrong
  group key, malformed record).
- No storage, no wire format, no Nostr kind number, no gossip. Nothing in the
  validator changes: a bare attestation remains valid; the journal is additive
  evidence.

### 5.2 v0.11 candidate — host wiring (specced, not built)

1. **Append on aggregate.** After `courtSigningMachine` reaches `aggregate`,
   the host calls `buildSigningJournal(...)` with the ceremony's own reveal set
   and appends `(seq, journal, duty, publishedAtSec)` to the CSJ. The append is
   atomic; a failed append must fail the publish (no signature without its
   record).
2. **Pin the shares.** The host supplies `dkg.verificationShares` to
   `verifyAggregateAttribution` before publishing; records the resulting
   `identityPinned: true`.
3. **Publish heads.** Periodically (e.g. per epoch) publish a signed `STH` on
   the relay and the site; retain entries for the cohort lifetime plus the
   dispute/appeal window.
4. **Per-participant entries (target).** Each juror appends its own
   commitment/partial entry (signed by its Nostr key) so the host cannot
   rewrite history; the host appends the aggregate entry. This is what makes
   P2 hold against `ADV-COORD`, not just against relays.
5. **Reserved surface.** A dedicated Nostr kind for journal/head events is
   *not assigned* in this round; do not squat a number without the protocol
   change. Likewise no gossip protocol is defined — head publication is manual.
6. **Enforcement hook for D-BATCH.** To make D1–D3 mechanical rather than
   host-side policy, the batch manifest hash must be inside the signed message
   the cohort signs (it is already in the event content; binding it into the
   FROST message is a signing-schema change, hence v0.11).

### 5.3 Compatibility

The journal is a *record*, not a new signature scheme: it changes no key
material, no message encoding, no validator rule. Consumers that ignore it
behave exactly as today; consumers that pin a cohort key can adopt
`verifyAggregateAttribution` incrementally.

---

## 6. Threat-model mapping

| Threat | Without the journal | With the journal (this control) |
|---|---|---|
| ADV-JUROR-<t contributes a bad partial to a valid aggregate | invisible | `PARTIAL_INVALID` at that index (Cor. 6.4) |
| ADV-JUROR-≥t produces a wrong-but-valid verdict | valid by design (PO-1) | still valid; **but** the contributing shares are now named and can be slashed/attributed |
| ADV-COORD drops or rewrites a session record | no trace | consistency proof fails / missing entry detectable (§3.2) |
| ADV-RELAY substitutes or replays a partial | frames a signer | per-signer NIP-01 authentication + append-only entry (P2) |
| ADV-JUROR signs an opaque batch root | plausible deniability | D5 duty record + attribution to the signer |
| Stale/duplicate batch across epochs | INV-BATCH-16 convention only | D1 forces the epoch/cohort binding into the signer's check |

---

## 7. Residuals

- **Detective, not preventive.** Collusion at threshold still produces a valid
  verdict; attribution is the control that makes the economic response
  (slashing, reputation, appeals) possible.
- **Host-side in v0.10.x.** The single-publisher journal does not bind the host;
  per-participant entries are the v0.11 fix (§5.2-4).
- **P1/P2 are caller obligations.** `identityPinned: false` is a warning that
  the result proves consistency only.
- **No log = no attribution.** Sessions signed before adoption are unattributable
  (Lemma 6.0); there is no retroactive recovery.
- **D-BATCH is policy until v0.11.** The protocol cannot see a batch root from
  inside `aggregateAttestation`; journaled duty records are the current
  evidence, a signing-schema binding is the mechanical fix.
