# BAO Court — Domain Glossary (v0.10.2)

Shared vocabulary for reviewers, auditors, and implementers. Terms are
defined as they are used **in this codebase**; where a term has a broader
industry meaning, the definition here is the stricter, normative one.
Invariant ids (`INV-*`) refer to `docs/FORMAL_INVARIANTS.md`.

---

## Ceremony structure

**1. Ceremony** — The full multi-stage protocol for one dispute:
jury selection → DKG → commit/reveal vote → (universal confirmation ladder,
when challenged) → FROST signing → published attestation. Each stage is a
pure state machine; the session hash (def. 4) threads all of them together.

**2. Stage** — One state machine within a ceremony: the DKG machine, the
vote machine, the confirmation machine, or the signing machine. Stages are
strictly ordered; each consumes the frozen output of the previous one.

**3. Round** — (a) A DKG round (1: commitments, 2: share
acknowledgments); (b) a ladder round of the universal-confirmation machine
(one expanded panel vote); (c) a signing attempt number. Which meaning
applies is always stated ("DKG round 2", "ladder round r", "signing attempt
n").

**4. Session hash** — `SHA-256(SessionParameters/v1 ‖ encode(params))` over
the validated canonical session parameters (`courtSession.ts`). The unique
identity of one ceremony attempt; every protocol event binds to it.

**5. Attempt** — The 0-based ordinal of a ceremony/ signing attempt for one
dispute. A failed attempt is never retried in place: the next attempt is a
new machine with a new session hash (and fresh FROST nonces).

## People and keys

**6. Juror** — A bonded, selected participant of one ceremony's roster,
holding one FROST secret share. Identified by a 1-based roster `idx` plus
their Nostr public key.

**7. Coordinator** — The juror (role `juror-coordinator`) that drives one
attempt's transport: collects commitments/reveals, broadcasts the aggregate.
The coordinator has no privileged cryptographic power — aggregation is
publicly verifiable.

**8. Host** — The embedding application (bao.markets, the 2140 client, an
agent). Owns all I/O: relays, wallets/rails, storage, clocks. The package
NEVER performs I/O itself; every boundary (relay pool, rail adapter,
clock via explicit `now`) is host-injected.

**9. Keeper** — A designated roster member holding the seed-derived secret
for one settlement branch (`keeper_yes` / `keeper_no`) of the BANOS
direct-settlement seam (`courtKeeper.ts`). Two distinct, non-exposed,
economically uninvolved jurors per contract.

**10. Group public key** — The FROST aggregate public key produced by DKG
(`certifiedGroupPubkey`). Attestation signatures verify against it; the
matching group secret never exists in one place.

**11. Attestation** — A Kind-39007 (legacy 89) Nostr event carrying the
FROST group signature over the canonical attestation message: the court's
published, publicly verifiable statement that a given outcome won a given
dispute round. Produced by the signing machine; validated by
`validator.ts`. **Not** a single juror's signature, and **not** the tally
itself.

## Voting

**12. Commitment (vote commit)** — `hashCourtVoteCommit`: the canonical,
session-bound hash `H(VoteCommit/v1, sessionHash, idx, outcome, salt,
allowedOutcomesRoot)`. Published as Kind 39004; unrevealable without the
salt (INV-VOTE binding invariants).

**13. Reveal (vote reveal)** — The Kind-39014 publication of
`(outcome, salt)` matching a prior commit. A reveal that does not hash to
its commit is excluded from the tally and surfaced as slashing evidence
(`TallyResult.invalidReveals`); it never aborts the count.

**14. Confirmation** — A public, signed juror endorsement of a proposed
outcome in the universal-confirmation machine (no commit/reveal — the
confirmation is itself the statement). Distinct from a vote: confirmations
are endorsements counted under a quorum, votes decide challenged cases.

**15. Verdict** — The tally output of a vote/confirmation round: winning
outcome + sorted supporting event ids + canonical verdict hash
(`COURT_VERDICT_DOMAIN` / `COURT_DISPUTE_VERDICT_DOMAIN`). The verdict is
what an attestation commits to; a verdict without an attestation is
unsigned evidence.

**16. Tally** — The counting operation (`tallyVotes` or the vote machine's
`finalize_tally`): verify reveals against commits, count per outcome, and
tie-break by canonical UTF-8 byte order. Deterministic and
order-independent across implementations.

## Attestation, batching, finality

**17. Finality tier** — The v2 in-band finality binding
(`AttestationMessage/v2`): an attestation's tier/threshold/epoch/
signer-set-root/batch-merkle-root are inside the signed message, so a
low-tier or stale attestation cannot masquerade as final under the same
cohort key. Consumers set a `minTier` / `minThreshold` policy.

**18. Epoch cohort** — A standing FROST cohort whose DKG is amortized
across one epoch (`epochCohort.ts`, paper §7): certified group key,
threshold, roster size, validity window, suite — anchored by one canonical
record hash. Rotation requires a new group key and a forward-moving window.

**19. Batch attestation** — A Kind-39018 event whose single cohort
signature certifies a whole epoch's verdict cohort via an RFC-6962 Merkle
root (`batchAttestation.ts`). Single cases verify with an O(log n)
authentication path.

## Escrow and settlement

**20. Stake / Bond** — A juror's escrowed stake (slashed for
incoherence/non-reveal/double-voting) vs a disputer's challenge bond
(returned if the dispute is upheld, forfeited otherwise). Both are
*evidence + ledger records* in this package (`escrow.ts`); the host moves
actual sats on its rail (ADR-001: Lightning hold invoices = Panel A, Liquid
escrow = Panel B).

**21. Slashing (redistribution plan)** — The deterministic per-round plan
(`computeRedistributionPlan`): rates ALPHA_INCOHERENT (50%) / non-reveal
(100%) / double-vote (100%), coherent jurors share the pool, dust-guard
treasury sweep when no juror is coherent. Pure — every observer derives the
identical plan.

**22. Hold invoice** — A Lightning hold invoice (Panel A) locked on a
deterministic preimage derived from the settlement witness. Settled
(preimage released) for coherent jurors / winning bonds, cancelled
otherwise, expired to the refund path (`lnSettlement.ts`, `lnRail.ts`).

## Errors and guarantees

**23. CourtError** — The unified error base (v0.10.1): every boundary error
is a `CourtError` carrying a machine-readable `code` (taxonomy:
`docs/FORMAL_INVARIANTS.md` §15) and, where applicable, the `invariant`
(`INV-*` id) it enforces. Legacy per-domain classes keep their names for
compat.

**24. Fail-closed** — The package-wide discipline: malformed, ambiguous, or
unverifiable inputs produce a typed error or a `valid: false` result, never
a default-allow path. Clock rollback, tampered state, empty pins, and
malformed hex are all rejected rather than coerced (§2 of
`docs/FORMAL_INVARIANTS.md`).

**25. Purity (module contract)** — A module marked *pure* performs no I/O,
reads no wall clock, and draws no randomness: all time is injected (`now`
fields / explicit parameters), all entropy is passed in or derived from
declared inputs. Any observer re-running a pure function on the same inputs
must derive byte-identical output.

---

*Version note: terms `attestation`, `verdict`, `confirmation`, and
`tally` are load-bearing in review discussions — see defs. 11, 15, 14, 16
for the precise distinctions.*
