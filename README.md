# @bao/court — BAO Court threshold oracle

[![CI](https://github.com/baocommunity/bao-court/actions/workflows/ci.yml/badge.svg)](https://github.com/baocommunity/bao-court/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE.txt)

BAO Court is a **FROST threshold oracle** for dispute resolution. A randomly
selected jury runs distributed key generation (DKG), votes under
commit/reveal, and produces a **threshold Schnorr attestation** over the
final verdict that any third party can verify against the Court's group
public key. The Court is the *authority* layer only: it decides outcomes and
authorizes downstream actions. It never holds, receives, redirects, or
intermediates user funds, and it contains no settlement logic.

This package is shared, platform-neutral TypeScript (browser and Node). It
contains no UI, no networking of its own beyond event builders/parsers, and
no persistence — hosts inject clocks, storage, and transport.

**Provenance.** This is the canonical public home of the BAO Court
package. It is developed alongside the `baocommunity/bao.markets`
reference implementation and published here under the AGPL-3.0.

**Paper.** The protocol paper — architecture, math, security analysis, and
production gates — is
[`docs/FROST_COURT_ORACLE_PAPER.md`](docs/FROST_COURT_ORACLE_PAPER.md).


---

## Quick start

`@bao/court` ships as **raw TypeScript source** (no build step, no `.js`
artifacts) and is **not published to npm** — it ships by git tag. Install
from this repo at the tag you want, and consume it with a TS-aware resolver
(**tsx**, **Vite**, or any bundler with TypeScript support). Plain `node`
cannot resolve the package's extensionless internal imports; see
[§11](#11-testing-and-gates) for details.

```bash
npm install github:baocommunity/bao-court#v0.5.4
npx tsx your-script.ts
```

A complete, runnable vote ceremony (3 jurors, 2 outcomes, commit/reveal,
frozen verdict):

```ts
import {
  createCourtVoteMachine,
  reduceCourtVoteMachine,
  hashCourtVoteCommit,
  hashCourtVerdict,
  type CourtVoteMachineState,
} from '@bao/court';

const sessionHash = 'a'.repeat(64);
const salt = 'b'.repeat(64);

// 1. Open the ceremony: 3 jurors, two outcomes, commit by t=1000, reveal by t=2000.
let s: CourtVoteMachineState = createCourtVoteMachine({
  sessionHash,
  participantIndices: [1, 2, 3],
  allowedOutcomes: ['YES', 'NO'],
  commitDeadline: 1000,
  revealDeadline: 2000,
});

// 2. Each juror commits a salted hash of their vote.
for (const idx of [1, 2, 3]) {
  s = reduceCourtVoteMachine(s, {
    type: 'accept_commit',
    idx,
    commitHash: hashCourtVoteCommit({ sessionHash, outcome: 'YES', salt }),
    eventId: String(idx).padStart(64, '0'),
    now: 100,
  });
}
s = reduceCourtVoteMachine(s, { type: 'close_commits', now: 1001 });
s = reduceCourtVoteMachine(s, { type: 'open_reveals', now: 1002 });
console.log('after commits: phase =', s.phase, '| commits =', s.commits.length);

// 3. Jurors reveal (outcome + salt) — each must match their own commit.
for (const idx of [1, 2, 3]) {
  s = reduceCourtVoteMachine(s, {
    type: 'accept_reveal',
    idx,
    outcome: 'YES',
    salt,
    eventId: String(idx + 3).padStart(64, '0'),
    now: 1500,
  });
}
s = reduceCourtVoteMachine(s, { type: 'close_reveals', now: 2001 });
console.log('after reveals: phase =', s.phase, '| reveals =', s.reveals.length);

// 4. Finalize: exactly one frozen verdict with a canonical hash.
const verdict = reduceCourtVoteMachine(s, { type: 'finalize_tally', now: 2002 }).verdict!;
console.log('verdict =', verdict.outcome, '| supporting =', verdict.supportingEventIds.length);
console.log(
  'verdict hash matches hashCourtVerdict:',
  hashCourtVerdict({ sessionHash, outcome: verdict.outcome, supportingEventIds: verdict.supportingEventIds })
    === verdict.verdictHash,
);
```

Output:

```
after commits: phase = reveal_open | commits = 3
after reveals: phase = reveal_closed | reveals = 3
verdict = YES | supporting = 3
verdict hash matches hashCourtVerdict: true
```

The ceremony pipeline below explains the full flow (selection → DKG → vote →
signing → attestation) this example is the middle of.


---

## 1. Ceremony pipeline

One dispute resolution proceeds through four certified stages:

```
selectJury()              IndependentDkgSession        CourtVoteMachine         CourtSigningMachine
─────────────────         ─────────────────────        ─────────────────        ─────────────────────
roster + threshold   →    FROST key shares        →    commit/reveal tally  →   threshold signature
(seed-bound, verifiable)  (group pubkey)               (frozen verdict)         (kind 89 / 39007 event)
```

1. **Selection** (`selection.ts`) — a seed derived from public block
   evidence deterministically selects the roster and backup jurors;
   `verifyJurySelection()` lets anyone recompute the draw.
2. **DKG** (`independentDkg.ts`, `dkg.ts`) — the roster runs Pedersen/PedPop
   DKG (`pedpop-v1-experimental` suite) so that *no party ever holds the
   group private key*. Output: each juror's FROST share plus the group
   verifying key.
3. **Voting** (`courtVoteMachine.ts`) — jurors publish session-bound vote
   commitments, then reveal; the tally produces exactly one frozen verdict
   with a canonical `verdict_hash`.
4. **Signing** (`courtSigningMachine.ts`, `independentSigning.ts`,
   `signing.ts`) — a threshold of jurors contributes FROST nonce commitments
   and partial signatures over the frozen verdict; aggregation yields a
   single Schnorr signature published as a Nostr attestation event.

Any contradiction, equivocation, or disqualification **aborts the attempt**
rather than degrading it — see §4.

## 2. Cryptographic stack

| Primitive | Implementation | Role |
|---|---|---|
| FROST threshold Schnorr | `@vbyte/frost` **1.1.5** (pinned compatibility gate) | group signing over verdicts |
| secp256k1 / Schnorr primitives | `@noble/curves` | share math, proofs of knowledge, verification |
| DKG | Pedersen/PedPop, suite id `pedpop-v1-experimental` | distributed FROST key generation |
| Private transport | NIP-44 v2 encryption, NIP-59 gift wraps (`nip44Crypto.ts`, `nip59.ts`) | shares, complaints, backups |
| Canonical hashing | SHA-256 over length-prefixed domain-separated encodings (`CanonicalWriter`, `courtSession.ts`) | every protocol binding |

**Compatibility gates (hard rules):**

- The FROST dependency is held at `@vbyte/frost` **1.1.5** (range `^1.1.5`,
  lockfile-pinned); any bump requires re-running the full vector suite.
- The legacy Pedersen/PedPop DKG must never be *labelled* ChillDKG.
- ChillDKG shares must never be fed into `@vbyte/frost` signing until
  BIP-445 test vectors pass and cross-implementation parity is demonstrated.
  ChillDKG is a planned suite upgrade, not the active suite.

## 3. The two-secret doctrine

BAO Court involves **two unrelated threshold-secret systems**. Confusing
them is a critical safety error, so they are documented together here:

| | FROST DKG shares (this package) | Settlement VSS shares (Construction B — settlement layer) |
|---|---|---|
| Secret | the Court's group signing key | one per-contract 32-byte Lightning HTLC preimage |
| Sharing | Pedersen/PedPop DKG — no dealer, no party ever holds the full secret | single designated dealer, Feldman-verifiable Shamir sharing over the roster |
| Shares ever revealed? | **Never.** A revealed share is a key compromise. | **By design.** After the Court's FROST attestation authorizes resolution, any *t* jurors publish shares and anyone reconstructs the preimage (SHA-256-checked against the committed hash). |
| Decides | *whether* an outcome is authorized | *who can physically produce* the winning secret |

Even in the settlement construction, **FROST gates everything**: no Court
attestation → no share release → no settlement. A FROST signature cannot
serve as an HTLC preimage (it is 64 bytes, and signature shares are bound to
their exact ceremony), which is why the settlement layer uses native 32-byte
secrets with their own VSS.

**Rule:** the two systems must never share code paths, storage, or key
material. Settlement-VSS dealing/reveal is future Court-side scope (Phase 7
of the upgrade plan) and will live in its own module.

## 4. Fail-closed invariants

The Court degrades to an abort, never to a weaker ceremony:

- **Unanimous-roster DKG.** `IndependentDkgSession.computeKey()` requires
  *every* roster juror's verified commitment and decrypted share. Any
  disqualification aborts the attempt (`getPhase() → 'failed'`); the Court
  restarts with a fresh roster. Computing a group key over a threshold-sized
  subset is forbidden — different subsets would derive *different* group
  keys, splitting the Court. Disqualification aborts take precedence over
  local setup errors.
- **Private blame, never secret evidence.** A share that fails `verifyVssShare`
  produces a `DkgVerificationFailure` (dispute id, accused/victim indices and
  pubkeys, commitment event id, `reason: 'invalid_share'`). It is kept
  private and **never carries the decrypted share** — complaint paths must
  not become share-oracles.
- **Decrypt-before-gate.** Hosts must decrypt and verify incoming shares
  *before* checking key-readiness; gating decryption on readiness deadlocks
  the ceremony (regression-covered).
- **One commit, one reveal, roster-bound.** The vote machine accepts exactly
  one commitment per roster index (identical redelivery is idempotent, a
  conflicting one throws). A reveal counts only if it matches the juror's
  own earlier session-bound commitment
  (`hashCourtVoteCommit({sessionHash, outcome, salt})`) and the commitment
  predates the reveal. Tallies are computed only from verified reveals —
  fabricated or unmatched votes cannot enter a tally. Ties break
  deterministically (lexicographically smaller outcome).
- **Frozen verdict signing.** The signing-session hash binds
  `sessionHash + verdictHash + outcome + signerSet + threshold + attempt`.
  Signers commit nonces to the *tallied* verdict; if the verdict changed
  after commitments were published, the attempt must abort and restart —
  hosts must never silently re-sign a different outcome.
- **Nonce-equivocation aborts.** Exactly one nonce commitment per signer per
  attempt. A conflicting commitment or partial signature from the same
  signer aborts the attempt as `aborted_peer` with blame; partials are
  accepted only from the finalized signer set; aggregation requires
  ≥ threshold partials and a 64-byte signature.

## 5. Canonical encoding and domains

All cross-party hashing uses `CanonicalWriter` (exported from
`courtSession.ts`): length-prefixed fields under an explicit domain string —
no concatenation ambiguity, no JSON serialization dependence.

Active domains:

- `BAO-Court/SessionParameters/v1` — the session hash every other artifact binds to
- `BAO-Court/VoteCommit/v1` — vote commitments
- `BAO-Court/Verdict/v1` — the frozen verdict hash
- `BAO-Court/SigningSession/v1` — the per-attempt signing-session hash

`courtSession.ts` validates and hashes session parameters (version,
environment, suite, roster, threshold, dispute binding); every protocol
event is then bound to that session via `courtProtocolEvents.ts`
(`bindCourtProtocolEvent` / `parseCourtProtocolEvent` /
`classifyCourtProtocolEvent`). Unbound or mis-bound events are rejected;
legacy event kinds are parseable for history only
(`parseLegacyCourtEventForHistory`) and never accepted as live protocol
input.

## 6. State machines

Three pure, fail-closed reducers model the ceremony. Each is
`create*Machine(params)` + `reduce*Machine(state, event)` with an injected
clock, a typed `*TransitionError`, terminal-phase rejection, and explicit
`tick`/`abort` events. They carry no I/O — hosts feed them events and
persist states.

- **`courtDkgMachine.ts`** — DKG round progression, complaint windows,
  expiry, abort classification.
- **`courtVoteMachine.ts`** — `commit_open → commit_closed → reveal_open →
  reveal_closed → tally_final` (+ `expired`/`aborted`); emits
  `{outcome, supportingEventIds, verdictHash}`.
- **`courtSigningMachine.ts`** — `intent → nonce_commit →
  commitment_set_final → partial_sign → aggregate → attestation_published`
  (+ `expired`, aborts); emits the publishable attestation.

The session-oriented classes (`IndependentDkgSession`,
`IndependentSigningSession`) wrap the same rules for hosts that prefer an
imperative API with snapshots (`independentSigning.ts` snapshot types
support resumability).

## 7. Nostr event surface

Event kinds and builders/parsers live in `events.ts` and `dkgMessages.ts`:

- dispute case, juror candidacy, selection result;
- DKG commitments, encrypted shares, complaints, share backups, refresh
  commitments/shares (private kinds are NIP-44/NIP-59-wrapped);
- vote commit / vote reveal;
- FROST commit / reveal;
- attestation — **kind 89** for normal verdicts, **kind 39007** for dispute
  overrides (`dispute.ts`, `deriveDisputeGroupPubkey`,
  `runDisputeOverrideSigning`).

`validator.ts` (`validateAttestationEvent`, `verifyRawSignature`) is the
consumer-side gate: given an attestation event and the expected group key,
verify structure, session binding, and the Schnorr signature.

## 8. Rails, bonds, and custody

The Court is **rail-agnostic**. Juror bonds are verified, not held, by this
package: `bondVerification.ts` (`verifyBond`, `computeRequiredBond`,
`createBaoMempoolVerifier`, `createEsploraVerifier`) checks bond evidence
against Bitcoin/Liquid backends (the BAO Markets custom signet Mempool in
practice). Demo rooms may stake on other rails (e.g. Spark) without any
change to Court code.

**Escrow lifecycle and slashing** live in `escrow.ts` (see
[`docs/ESCROW-SLASHING.md`](docs/ESCROW-SLASHING.md)):

- **Bond ownership proof** — `createBondOwnershipChallenge` / `signBondOwnershipProof` /
  `verifyBondOwnershipProof` let a depositor prove control of the bond UTXO
  (BIP-340 signature over a deterministic challenge binding
  `txid|vout|dispute|juror|nonce`), closing the coordinator's former
  ownership-verification gap.
- **EscrowLedger** — a deterministic, serializable state machine
  (`pending → locked → returned | slashed_50 | slashed_100 | redistributed |
  failed`) that hosts persist and apply to their rail. No sats move inside it.
- **Slashing math** — `calculateBondAmount`, `calculateJurorStake`,
  `calculateTotalAtStake`, `computeRedistributionPlan` and
  `verifyRedistributionIntegrity` implement the Kleros-style rules
  (coherent keep + share, incoherent −50%, non-reveal −100%, double-vote
  −100%, bond returned/forfeited by outcome, treasury fallback when no
  coherent juror). Deterministic and integer-exact.

There are **no HTLCs in the Court path**. Lightning contracts, invoices,
and settlement state machines belong to the settlement layer (see §9). The
Court's only economic acts are attestations and authorizations.

**Settlement rails (v0.3.0)** — see
[`docs/SETTLEMENT-RAILS.md`](docs/SETTLEMENT-RAILS.md):

- **Panel A (Lightning hold invoices)** — `lnSettlement.ts` / `lnRail.ts`:
  deterministic preimage/payment-hash derivation (BOLT semantics), hold
  lifecycle state machine, settle/cancel decisions from the
  `RedistributionPlan`, audit-event templates, and a host `LnRail` contract.
- **Panel B (Liquid P2WSH/Taproot escrow)** — `liquidEscrow.ts` /
  `liquidRail.ts`: M-of-N CHECKMULTISIG and judge/refund Taproot script
  trees, BIP-173/BIP-350 addresses, release-skeleton builder, M-of-N witness
  assembly, and a host `LiquidRail` contract.

Both rails are protocol-side: hosts implement the adapters privately against
BAO signet nodes and broadcast. No keys or credentials live in this package.

## 9. Seam interface — Court × BANOS direct settlement

Agreed 2026-08-10 with the parallel bao.markets settlement session
(`BANOS_DIRECT_RECIPROCAL_HTLC_PLAN.md`): that session owns manifests,
reciprocal invoices, two-party activation, trader agents, griefing-bond
legs, and the settlement state machine; this package owns jury selection,
FROST attestations, challenge windows, dispute resolution, and Court-side
secret custody. The settlement layer imports exactly four things:

1. **Final resolution attestation + challenge-closure signal** — the kind
   89 / 39007 pipeline (exists; session- and roster-bound since the 2026-08
   hardening).
2. **Reveal authorization** — a Court-signed artifact stating "contract X,
   outcome Y, challenge closed", bound to manifest hash and resolution
   version; only then may a settlement secret be released. (Planned.)
3. **Secret custody duties** — keeper designation + reveal (Construction A,
   demo) and dealt Feldman VSS over the roster (Construction B, mainnet
   gate). Keepers/dealers are jurors chosen by `selection.ts` randomness
   under exclusion rules (never a contract participant, never the receiver
   of the funds their secret locks, no market exposure). (Planned; own
   module per §3.)
4. **Bond-slash authorization** — Court-authorized reveal of a trader's
   griefing-bond secret on attributable abandonment, judged against the
   settlement plan's evidence standard (manifest deadline + authenticated
   acceptance evidence from *both* traders' nodes + contest window).
   (Planned.)

The attestation evidence consumers rely on must be able to bind:
`protocol, network, market_id, contract_id, manifest_hash,
resolution_version, final_outcome, challenge_closes_at,
winning_secret_commitment`.

## 10. Module map

| File | Responsibility |
|---|---|
| `types.ts` | shared protocol types (roster, DKG records, complaints, failures, votes) |
| `crypto.ts` | secp256k1/Schnorr helpers, proofs of knowledge, `@vbyte/frost` wrapper |
| `courtSession.ts` | session parameters, `CanonicalWriter`, session hash |
| `courtProtocolEvents.ts` | session binding/parsing/classification of all protocol events; legacy history parsing |
| `courtDkgMachine.ts` | DKG state machine |
| `courtVoteMachine.ts` | vote commit/reveal/tally state machine + verdict hashing |
| `courtSigningMachine.ts` | FROST signing-session state machine + signing-session hashing |
| `dkg.ts` | Pedersen DKG adapter, VSS verify, share combine, refresh math |
| `independentDkg.ts` | host-facing DKG session (fail-closed, private blame) |
| `signing.ts` | FROST round helpers + nonce-reuse guards |
| `independentSigning.ts` | host-facing signing session with snapshots |
| `dispute.ts` | dispute-override tally/signing (kind 39007) |
| `events.ts` | public event kinds, builders, parsers, selection validation |
| `dkgMessages.ts` | private DKG message kinds (shares, complaints, backups, refresh) |
| `nip44Crypto.ts` / `nip59.ts` | NIP-44 v2 encryption and NIP-59 gift wrapping |
| `courtSigner.ts` | external-signer transport (NIP-07/NIP-46): no raw `nsec`, strict verified unwrap |
| `courtNip46.ts` | Court-scoped signer capabilities (session/suite/network/roster/peers/kinds/phase/window) |
| `courtOutbox.ts` | durable outbox: semantic dedupe, signed kind-39008 acks, retry/deadline, snapshots |
| `courtKeeper.ts` | keeper designation + commitment/reveal verification (settlement seam, Construction A) |
| `courtInbox.ts` | recipient inbox: Court relay group, roster author-filtered subscriptions, dedupe with per-relay provenance |
| `courtHostKey.ts` | encrypted Court host-key lifecycle: zeroizing handle, NIP-44 self-backup, candidacy-carried attestation, rotation/supersession chain |
| `courtRecovery.ts` | versioned legacy recovery envelope with full curve recomputation on restore (migration support, not ChillDKG recovery) |
| `selection.ts` | seed derivation, verifiable jury/backup selection |
| `bondVerification.ts` | juror bond evidence verification (Mempool/Esplora) |
| `escrow.ts` | bond ownership proofs, escrow lifecycle ledger, slashing/redistribution plan |
| `lnSettlement.ts` / `lnRail.ts` | Panel A: hold-invoice protocol + host LnRail contract |
| `liquidEscrow.ts` / `liquidRail.ts` | Panel B: P2WSH/Taproot scripts, addresses, skeletons + host LiquidRail contract |
| `appealTiming.ts` | JIT appeal phase timings (defaults + boundary helpers) |
| `appealCoordinator.ts` | event-driven JIT appeal pipeline (dispute → candidacy → selection → DKG → vote → signing → attestation); relay transport host-injected |
| `appealWatcher.ts` | kind-39007 attestation watcher: validate under the group key, route override outcomes; pool host-injected |
| `validator.ts` | consumer-side attestation validation |

## 11. Testing and gates

```bash
npm install        # installs runtime deps (noble, nostr-tools, @vbyte/frost)
npm test           # vitest suite
npm run typecheck  # tsc --noEmit
npm run simulate:court  # one-shot end-to-end court simulation (selection →
                        # DKG → vote → FROST sign → validate → escrow/slashing
                        # → LN hold decisions → Liquid escrow), hermetic,
                        # deterministic per seed
```

The same pipeline the simulation drives is asserted in
`__tests__/simulateCourt.test.ts` (all steps green, same-seed
reproducibility, time budget).

Consumption: this is a **source package** — the `exports` map points
straight at `.ts` files, and the runtime is expected to be a TS-aware
resolver (**tsx**, **Vite**, bundlers). The package's internal imports are
extensionless, so plain `node` (CJS or ESM) will fail to resolve them
without a loader. Use `npx tsx your-script.ts` for a Node smoke test; the
Quick start section has a complete runnable example.

```ts
import { ... } from '@bao/court';       // root: state machines, hashing
import { ... } from '@bao/court/events'; // event builders/parsers
```

- Regression tests cover, among others: threshold-subset finalization
  refusal, invalid-share blame without plaintext disclosure, decrypt-before-
  gate ordering, fabricated-commit rejection, frozen-verdict signing, and
  nonce-equivocation aborts.


## 12. Status

Active suite: `pedpop-v1-experimental`. Protocol layers (selection, DKG,
vote, signing, attestation, escrow/slashing, settlement rails, appeal
coordinator/watcher) are implemented and test-covered in this package; rail
execution, cross-client ceremonies, and contract-enforced phase deadlines
are the remaining production gates — see the honest list in the paper
(`docs/FROST_COURT_ORACLE_PAPER.md` §10). The phased hardening/upgrade plan
— including authenticated multi-relay transport, host keys, ChillDKG
adapter, and bonds/production integration — is tracked in the
`baocommunity/bao.markets` reference repository.

## 13. Security hardening (2026-08-15)

A full adversarial review found and fixed four substantive weaknesses. The
fix memo is `docs/FIXES-2026-08-15.md`; the complaint protocol contract is
specified in `docs/COMPLAINT-PROTOCOL.md`.

### DKG complaint possession binding (breaking change)

Kind 38032 complaints are now **possession-bound and victim-authored**:

- `DkgComplaint` gained a required `encryptedShareEventId` field — the kind
  39003 share event the victim received from the accused. Complaint events
  without it are structurally invalid.
- `parseDkgComplaintEvent` **rejects any complaint whose signed author is not
  the victim pubkey** (complainer === victim). A complaint for a victim that
  never was the author cannot enter arbitration at all.
- `IndependentDkgSession.addComplaint` now **returns boolean** and admits a
  complaint only when victim/accused are distinct certified roster members,
  the carried pubkeys match the roster, the possession anchor is a valid
  share-event id, the complainer is not disqualified, the pair has no prior
  complaint (first wins), the per-roster budget holds, and (when this session
  IS the victim) the accused actually delivered an encrypted share to this
  session.
- `resolveComplaints` settles each (victim, accused) pair once, exonerates
  the accused when the revealed share (or a valid defense) verifies against
  the public commitments — surfacing the complainer via `getFalseComplaints`
  for slashing — and only disqualifies on genuine invalid shares or bogus
  defenses. Complaints from disqualified complainers are void.

**Why this matters:** without the binding, an attacker could file complaints
on behalf of any victim, force t public defenses that each reveal one
polynomial evaluation point of an honest juror, and reconstruct the group
secret, or simply permanently disqualify honest jurors. With the binding,
an honest juror reveals at most one point per actually-misbehaving peer, so
polynomial recovery stays impossible under an honest majority.

**Migrating consumers:** `addComplaint` returns `boolean`; complaint events
must carry `['share', <kind-39003-event-id>]` and be signed by the victim.

### Legacy NIP-59 unwrap is now strict

The seckey-backed `unwrapProtocolEvent`/`unwrapProtocolEvents` previously
performed two plain NIP-44 decrypts (stock nostr-tools `nip59.unwrapEvent`),
returning attacker-crafted rumors as if they were legitimate mail. They now
run the same gate as the signer path (`courtSigner.ts`): recipient `p` tag,
seal Schnorr signature, seal-author === rumor-author, and rumor-id
recomputation. Anything failing any check returns `null`.

### `restoreFromBackup` recomputes everything

`IndependentDkgSession.restoreFromBackup` previously trusted the backup's
group key and verification shares after a single x-only share check. It now
runs the full recomputation battery (same gates as `courtRecovery.ts`):
1..n ordered indices, per-participant commitment counts equal to the
threshold, group key recomputed from the constant commitments, every
verification share recomputed from the commitments, and the local share
checked by **full point** (parity-exact — an x-only check would certify the
negated share `n − s`). A self-consistent backup under a different group
key — mintable by any party that once invoked `nip44_encrypt` on the
signer — is rejected.

### Other fixes

- `seededScalar` counter encoded as a full uint16 (no truncation collision).
- Test-timeout hardening for the heavy crypto/fuzz suites (load-dependent
  flakes).

See `docs/COMPLAINT-PROTOCOL.md` and `docs/FIXES-2026-08-15.md` for the full
analysis, reproduction evidence, and each check's rationale.

## License

**Copyright © 2026 baocommunity.**

This program is licensed under the **GNU Affero General Public License
v3.0** (see `LICENSE.txt`). The copyright and attribution notices in
`NOTICE.md` must be preserved in all copies and derivative works, per
AGPL-3.0 Section 5(c).

Private license grants (commercial / agentic exceptions, e.g. to
BAO MARKETS) are available from the copyright holder separately.

## Contributing

See `CONTRIBUTING.md` — contributors must sign the baocommunity CLA;
copyright of contributions is assigned to baocommunity.
