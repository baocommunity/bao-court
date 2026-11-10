# BAO Court — FAQ

> Protocol-accurate as of `@bao/court` **v0.7.2**. Redesign items are marked
> **[roadmap]** and are specified in the redesign proposal (see the reference
> repository's `docs/proposals/`); they are not live protocol behaviour yet.

**01 — What is BAO Court?**
A FROST threshold oracle for dispute resolution. A randomly selected jury runs
distributed key generation (DKG), votes under commit/reveal, and produces a
threshold Schnorr attestation over the final verdict that any third party can
verify against the Court's group public key. It is the *authority layer only*:
it decides outcomes and authorizes downstream actions — it never holds,
receives, or intermediates funds.

**02 — Who is it for?**
Anyone whose contract needs a neutral verdict: BAO Markets disputes today, and
any platform that names the Court as its adjudicator in its own terms
(**[roadmap]** external-claim intake, Angor first). Jurors can be humans or
autonomous agents.

**03 — Why not just trust the operator?**
Because "trust us" is not a guarantee. A verdict is a threshold signature over
a group key that **no single party — including the operator — ever holds**
(it is born in DKG, with no dealer). Verification requires no access to the
Court, its jurors, or its operators, and works offline from the public
library. Two honest qualifications: prototype deployments co-locate the shares
(single-process ceremonies — paper §10.2 G), and a verdict is not a payout —
v1 settlement is host-mediated, so the operator can release but cannot alter a
verdict ([`docs/SETTLEMENT-BINDING.md`](SETTLEMENT-BINDING.md)).

**04 — How is a dispute resolved?**
Four certified stages: (1) seed-bound jury selection — anyone can recompute
the draw from public block evidence; (2) Pedersen/PedPop DKG — the group key
is born without any dealer; (3) commit/reveal voting — a frozen verdict hash
is tallied from verified reveals only; (4) threshold FROST signing — published
as a public attestation (kind 89 / 39007). Any contradiction aborts the
attempt rather than degrading it.

**05 — Who are the jurors?**
Registered candidates selected by a lottery derived from public block
evidence — no applications, no favoritism, no insider seat. Market
participants and otherwise-exposed parties are excluded; backup jurors are
drawn at the same time; `verifyJurySelection()` lets anyone recompute the
roster.

**06 — Do jurors stake anything?**
The protocol **verifies** juror bonds (against Bitcoin/Liquid backends) and
computes Kleros-style slashing: coherent jurors keep their stake and share the
slashed pool, incoherent jurors lose 50%, non-reveal and double-voting lose
100%, and the disputer's bond is returned or forfeited by outcome. All
deterministic and integer-exact. **[roadmap]** a vetted, zero-stake, fee-paid
juror program with reputation-derived selection weighting.

**07 — How do I verify a verdict myself?**
Attestations are public Nostr events. Recompute the verdict hash from the
session parameters and the revealed votes, then check the BIP-340 Schnorr
signature against the Court's group public key. `validator.ts`
(`validateAttestationEvent`) does this in a few lines of TypeScript, offline —
you never need to ask BAO.

**08 — What happens to a bad or lazy juror?**
Slashing is deterministic: −50% for voting against the tally, −100% for
withholding a reveal or double-voting; coherent jurors split the slashed pool;
with no coherent juror the pool goes to the treasury by fixed rule. Anyone can
recompute the redistribution plan from public inputs and run
`verifyRedistributionIntegrity` before trusting a slash event.

**09 — Does the Court hold or move funds?**
Never. It decides and authorizes. Settlement — Lightning hold invoices, Liquid
P2WSH/Taproot escrow — is executed by hosts against their own rails via
injected rail adapters. The package contains no custody, no credentials, no
settlement logic.

**10 — What if both parties agree?**
The dispute pipeline never runs: the contract settles on its own terms. The
Court exists for the cases that fall off the happy path. **[roadmap]**
universal jury confirmation — every settlement attested by default, disputed
or not.

**11 — What if the evidence is genuinely unclear?**
The protocol fails closed: ceremonies abort rather than degrade, ties break
deterministically (lexicographically smaller outcome), and when no juror is
coherent the pool goes to the treasury. Nothing is settled by invented
interpretation. **[roadmap]** an explicit UNDETERMINED outcome path.

**12 — Which chains does it use?**
The protocol is rail-agnostic. Bond verification runs against
Bitcoin/Liquid backends (Mempool/Esplora verifiers are provided). Settlement
adapters exist for Lightning hold invoices (Panel A) and Liquid
P2WSH/Taproot escrow (Panel B), with Elements-consensus taproot script-path
spends proven by a real on-chain transaction (`npm run test:live`).

**13 — Is juror deliberation private?**
Yes. Votes are committed secretly (salted, session-bound hash) and revealed
later. DKG shares, complaints, and backups travel NIP-44-encrypted under
NIP-59 gift wrap, with strict verified-unwrap. No juror ever holds the group
private key, so there is nothing to steal from any single juror.

**14 — Is the protocol open?**
Yes — AGPL-3.0, developed in the canonical public repo, shipped as
platform-neutral TypeScript source (no build step), with normative test
vectors and a deterministic end-to-end simulation (`npm run simulate:court`).

**15 — How do I try it?**
Clone the repository, `npm install && npm test` (full suite), then
`npm run simulate:court` to watch a complete ceremony — selection → DKG →
vote → signing → attestation → escrow/slashing → settlement rails — execute
deterministically. Integration starts with the validator.

**16 — What is on the roadmap?**
Universal jury confirmation (every settlement attested, disputed or not); an
escalating appeal ladder (5 → ~1215 jurors, loser-funded rounds, finality =
closed appeal window); Nostr reputation badges derived from public attestation
evidence; and external-claim intake so partner platforms (Angor first) can
route disputes to the Court under their own evidence standards.
