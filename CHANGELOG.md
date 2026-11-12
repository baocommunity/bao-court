# Changelog

All notable changes to `@bao/court` are documented here. This package ships
by git ref/tag (not npm) — see `AGENTS.md`. Breaking changes are flagged per
version with their consumer impact.

The version scheme: **patch** = bug fixes, **minor** = new modules/capabilities
or consumer-visible API changes. `1.0.0` stays reserved until the
trusted-dealer DKG is replaced with production Pedersen DKG and the API is
frozen.

## [Unreleased]

### Fixed (round 54 — replay is not equivocation: the collapse that must come first)
- **False equivocation on replay.** `scripts/court/distributed-ceremony.mjs`
  reported a duplicated-and-late-redelivered DKG commitment as an equivocation
  and blamed an honest juror. The coordinator's audit of the relay log compared
  the parsed proof-of-knowledge object by **reference**
  (`existing.parsed.pok === parsed.pok`), which is false for two parses of the
  same event, so the "byte-identical duplicate" branch could never fire.
  Reproduced on untouched `origin/main` with `--scenario=replay` (n=3 k=2):
  `equivocatingJurors:[2]`, `duplicatesIgnored:0`, and three assertions failed —
  the group key could not be re-derived from the relay log, the FROST signature
  could not be verified against it, and "exactly one DISTINCT commitment per
  juror" failed.
- **`courtCeremonyCore.ts`** gains `signedRecordIdentity` and
  `collapseSignedRecords` (exported from `index.ts`): collapse **byte-identical
  signed events** (same event id, payload hash as fallback — never the arrival
  index) before any equivocation reasoning, keyed by `(phase, round, jurorIdx)`,
  and report blame only for a **different** identity under the same key. The
  harness now calls it instead of re-implementing the comparison; the session
  classes already compared by value and are unchanged.
- **Assertions**: the harness now requires the collapsed count to equal the
  number of records the relay marked `injected` ("replay is not equivocation"),
  and the equivocation check reports `duplicatesCollapsed` and
  `unparsedCommitments` (an unparseable record is counted, never blamed).
- **Tests**: `__tests__/replayEquivocation.test.ts` — the captured trace of the
  failing run (`__fixtures__/replay-wire-n3-k2.json`) yields zero accusations,
  while a constructed genuine equivocation is still detected and blamed on the
  right juror, including replay and equivocation in one stream.

### Added (round 53 — the ceremony bond gate: a seat costs a PROVEN bond)
- **`bondCheckGate.ts`** (`buildBondCheckArgs`, `parseBondCheckOutput`,
  `gateRosterOnBonds`, `BOND_CHECK_ENV`) — the protocol side of a pluggable,
  host-verified bond check. The host supplies
  `BAO_COURT_BOND_CHECK_CMD`; the harness invokes it once per juror with
  `--rail= --network= --proof= --bond-sats= --juror-pubkey=`, expects exit 0 +
  `{"ok":true,"proofRef":…,"sources":[…]}` and treats EVERY other outcome
  (non-zero, junk, timeout, a proven-but-different `proofRef`, a check that
  never ran, `rail:"none"` under `--require-bonds`) as an exclusion. This
  package stays free of chain clients: no explorer, no RPC, no credentials.
- **Enforcement point**: `scripts/court/distributed-ceremony.mjs` gates the
  roster AFTER the boxes publish their keys and BEFORE `roster.json` is written,
  so an excluded juror never joins a DKG. Survivors are re-seated at sequential
  indices with the key they generated on their own box; if they cannot reach the
  threshold the ceremony fails closed with `ROSTER_BELOW_THRESHOLD` — no roster,
  no key, no signature. `--require-bonds`, `--bond-sats=`, `--bonds=` /
  `--bonds-file=`, `--bond-check-timeout-ms=`,
  `--expect-classification=` (turns a refused run into a PASS for negative
  tests). `--require-bonds` without the command is refused at startup. With the
  environment variable unset the harness behaves exactly as before
  (`bondVerified:false`, nothing enforced).
- **Artifacts** record, per juror, `bondRef` / `bondVerified` / `sources` /
  `code`, the exclusions with their typed refusal, and the gate decision; public
  material only.
- **Live proof** (3 boxes + relay, 2026-11-12): bonded quorum with three
  Liquid-testnet bonds proven by `blockstream` + `liquid-network` (one key, one
  verified signature); a negative k=3 run where a spent outpoint is `BOND_SPENT`
  → `ROSTER_BELOW_THRESHOLD` with no key and no signature; a rail-agnostic run
  with an on-chain testnet4 juror (first-party `gettxout` + `mempool.space`);
  and the inert control run. `docs/MULTI_PROCESS_CEREMONY.md` § "The bond gate".
- **`__tests__/bondCheckGate.test.ts`** — the argv contract, the strict output
  parser, and every roster decision (inert, proven, refused, missing verdict,
  proof mismatch, `rail:"none"` strict/non-strict, below-threshold,
  impossible-input rejection).

### Added (distributed ceremony soak — the ceremony on a 6-hourly timer)
- **`scripts/court/distributed-ceremony-soak.mjs`** — the unattended runner: it
  rotates `happy-k2`, `happy-kn`, `kill` (SIGKILL over ssh mid-signing), `replay`
  and `reorder` (Byzantine *delivery*: the relay repeats or re-orders signed
  records, never forges one), plus opt-in `silence`, and writes one JSONL record
  per run (`ts, scenario, k, n, outcome, groupKeyFingerprint, signatureVerified,
  durationMs, perBoxWallMs, relayRttP50, classification, evidencePath` and the
  cleanup proof). It preflights every box (reachable? Node present?) and records
  a `blocked` outcome with the reason instead of hanging; it kills strays by
  EXACT command line before and after each run; it accounts for reboots as
  `gap` records (boot-id + elapse), never as failures; it keeps a rolling cap on
  evidence directories. No key, share, seed, nonce or token is ever written.
- **`scripts/court/systemd/bao-court-ceremony-soak.{service,timer}`** —
  `OnBootSec=15min`, `OnUnitActiveSec=6h`, `Persistent=true`,
  `RandomizedDelaySec=5min`; the service wraps the run in `flock -n` and
  `timeout --kill-after=60s 600s` and treats exit 1/2 (failed/blocked ceremony)
  as data, not unit failure.
- **`scripts/court/ceremony-soakctl.sh`** — `install|uninstall|start|stop|pause|
  status|report|run-now|logs|preflight|next` over user units (no root).
- **`relay-server.mjs` gains delivery policies** `honest` (unchanged default),
  `replay` (deterministic stride of byte-identical duplicates, re-delivered
  late), `reorder` (seeded sender permutation × window, per-sender FIFO kept) and
  `silence` (one juror's records withheld). Deterministic by construction: a run
  always exercises the policy instead of depending on a coin flip.
- **Coordinator dedupes replayed commitments** exactly as a receiving juror
  does: one *distinct* commitment per juror, with byte-identical repeats counted
  and two different commitments from one juror reported as equivocation.
- `docs/MULTI_PROCESS_CEREMONY.md` §"The continuous program" — cadence,
  rotation, JSONL shape, timer/control, status block, what a series proves over
  a single run, and what it still does not.

### Added (distributed ceremony — three real boxes, one real network)
- **`scripts/court/relay-server.mjs`** — the ceremony relay as a standalone
  process: the same JSON protocol the harness speaks (`POST/GET /events`,
  relay-assigned monotonic `seq`), plus a shared bearer token read from a 0600
  file, a hard `--max-records` cap, its own per-request handling timings, and a
  token-gated `GET /log` so a coordinator can audit the run from the relay's
  own receive log.
- **`scripts/court/distributed-ceremony.mjs`** — the distributed driver:
  `esbuild`-bundles `juror-child.ts` into a single `juror.mjs`, scp's it to one
  box per juror (no repo, no `node_modules`), has each box GENERATE ITS OWN key
  (0600, never transmitted; only the x-only public key crosses the wire),
  launches the jurors over ssh, hosts the relay on another box, re-derives the
  group key from the published commitments and verifies the aggregate itself,
  measures real per-request RTT and per-box wall time, and delivers a SIGKILL
  over ssh in the kill scenario.
- **`bondVerification.ts`: `CourtBondRef` / `parseCourtBondRef` / `UNBONDED`** —
  the rail-agnostic bond reference a ceremony roster entry now carries
  (`rail: liquid|lightning|onchain|cashu|none`, `network:
  testnet|signet-public|private-signet`, `proofRef`). Carried and recorded
  verbatim; **verification is a separate per-rail step and is not implied** —
  this round uses `rail:"none"` for every juror. New error code
  `BOND_ARGUMENT`.
- `juror-child.ts` gains `--relay-url`, `--token-file`, `--identity-file`,
  `--roster-file`, `--timings-file`, `--identity-only` and
  `--reveal-delay-ms`. With none of them supplied its behaviour is unchanged.
- `docs/DISTRIBUTED_CEREMONY.md` + `docs/benchmarks/distributed-ceremony/` —
  topology, exact commands (including the static Node install on the box that
  had none), both happy runs (k=2, k=3), the kill-mid-signing run, the measured
  latency table, and the honest limits.

### Fixed (r30/r52a — a faster peer's FROST commitment was discarded)
- **The phase-segregated receive loop threw away out-of-phase signing messages
  (`juror-child.ts`).** The juror polled DKG traffic until the key was
  computable, then signed; a peer that finished DKG first published its FROST
  commitment while a slower peer was still in DKG, and the slower peer's cursor
  had already advanced past that record — so an honest, healthy peer looked like
  it never committed (`SIGN_MISSING_PARTICIPANT`). Invisible on loopback (a
  few hundred microseconds of window); it fires across boxes with 25–70 ms
  RTTs. `frost-commit`/`frost-reveal` records seen during DKG are now DEFERRED
  and ingested when signing starts (`disclosure.deferredIngested`). Found by the
  first three-box k=2 attempt.

### Fixed (round 52 — the exported ladder bound IS the safe predicate)
- **`deriveMaxLadderRounds` named the BREAK-EVEN round at an exact-integer
  boundary (r52-1; found by round 46a's mechanisation, class H-2).** The cap was
  `min(MAX, floor(ln(ρ/(ρ+β))/ln a_f))`; at `a_f = ½, β = 3ρ` that `floor` lands
  exactly on the break-even depth (`E[π](2) = 0`), which the safety contract —
  strict `E[π](d) < 0` — EXCLUDES. The published gate `ladderCapWithinBound`
  refused the exported cap, so the number a host reads and the decision the gate
  makes disagreed by one round: the report-vs-decision mismatch class. Verified
  at `a_f = ½, β = kρ` for `k = 3, 7, 15, 31` and at `a_f = ¾, β/ρ = 7/9`: the
  old value was `flipRound`, the new value is `flipRound − 1`.
  The cap is now the predicate itself, evaluated exactly — `R·D^d < A^d·(R+B)`
  in `BigInt` on the rational each parameter names (`0.03` → `3/100`) — with no
  logarithm and no floating-point comparison on the decision path. Boundary
  semantics, now explicit in the docstring and the docs: **the returned depth is
  the largest strictly-profitable-to-refuse depth; the break-even depth is not
  included.** `deriveLadderFlipRound` is likewise the first depth that is not
  strictly unprofitable (exact for every round a legal cap can reach), so
  `deriveMaxLadderRounds = flipRound − 1` (clamped) holds at EVERY parameter
  point. `ladderCapWithinBound().ok` uses the same exact predicate, so the gate,
  `derivedCap` and the retired `cap <= derivedCap` composition now agree
  (r40-4's divergence is gone). Side effects, both in the safe direction: a
  `ρ+β` overflow (`1e308 + 1e308`) no longer reports a perfect jury (cap 5 →
  0 — the ratio is exactly ½), and `ladderSignBoundary` is documented as float
  telemetry that no decision reads.
  **Consumer impact:** a cap may be one round SHALLOWER than before, and only at
  an exact-integer boundary; no accepted escalation changes. New property suite
  `__tests__/ladderBoundExact.test.ts`: 460-configuration grid against an
  independent exact-rational oracle, the boundary table, and the Lean `d = A·B`
  witness through the module's exports.

### Changed (round 51 — the suite is load-insensitive by construction)
- **No test asserts elapsed time any more.** The three remaining wall-clock
  gates (`simulateCourt` 30 s, `adversarialNostr` 30 s, `r30InboxOutboxLoad`
  120 s) are gone, not raised — they were the class that produced two false
  mutation captures and an external 12-red reproduction on a docs-only tree.
  `simulateCourt` keeps its eight-step/outcome contract plus a new seed-differs
  anti-vacuity lock; the over-served-tag test now proves the scan is **linear by
  counting tag reads at two sizes** (work count, no clock).
- **Every harness timeout is a derived watchdog.** `__tests__/helpers/watchdog.ts`
  calibrates the box per worker (min of short bursts = cycle cost, max of long
  bursts ÷ that = load factor, clamped [1, 8]) and multiplies the declared
  margin; `vitest.config.ts` + `__tests__/helpers/determinism.setup.ts` install
  it as the default. `BAO_TEST_WATCHDOG_MS` replaces every ceiling,
  `BAO_TEST_WATCHDOG_TRACE=1` prints the per-worker factor. All 49 declared
  timeouts and the r30/r33 subprocess phase deadlines route through `wd()`
  (the fixed `--deadline-ms=4000` made three honest jurors "fail closed" under
  load — 2 of 7 reproduction failures).
- **No polling or sleeping in tests**: `vi.waitFor` (1 s poll deadline) and two
  `setTimeout` synchronisation hacks are replaced by awaiting the promise the
  SUT resolves (the dedupe reservation is synchronous, so the assertion is
  strictly stronger). Three unseeded `Math.random()` fixtures are seeded.
- **The multi-process ceremony's phase deadline now bounds SILENCE, not elapsed
  time** (`scripts/court/juror-child.ts`). `while (Date.now() < dkgDeadline)`
  made "loaded box" indistinguishable from "juror died": the poll loop's own
  20 ms sleeps stretch under load, an honest phase overran the budget and the
  juror reported `DKG_MISSING_PARTICIPANT` for a live peer (the r30 replay test
  flaked 4/20). Every accepted record now resets the clock; a dead/silenced peer
  still fails closed with the same typed classification after the same budget.
- **Enforced, not advisory**: `__tests__/determinism.test.ts` re-checks the
  rules statically on every run (no clock assertions, no timers, no `waitFor`,
  no `Math.random`, no bare numeric timeout, no fixed `--deadline-ms`) and
  proves the watchdog FIRES on a deliberately starved run. Rules and evidence:
  `docs/TEST_DETERMINISM.md`.

### Fixed (round-49 differential — the escalation wire reimplemented independently)
- **The escalation mapper threw raw `TypeError`s on a restored snapshot
  (r49-d1).** `escalationRequestToMachineEvent` read `state.ladderRound` and
  `state.challenges.filter(...)` before any shape check, so `state = null`
  escaped as `Cannot read properties of null (reading 'ladderRound')`, a
  non-array ledger as `state.challenges.filter is not a function` (measured: 344
  of 100 000 differential cases) and a `null` ledger row as `Cannot read
  properties of null (reading 'bondProofHash')` (95 cases). `@bao/court`
  documents a typed-only boundary (`errors.ts`, r3-1/r41-1) and already owns the
  guard (`assertStateArrays`), which exists for exactly this; the mapper now
  requires a record state, an array ledger and object rows, all typed refusals.
  **Consumer impact:** a host that passed a malformed snapshot now gets
  `CourtConfirmationTransitionError` instead of a `TypeError` — no accepted
  escalation changes.
- **`buildCourtEscalationRequest(null)` escaped as a raw `TypeError` (r49-d2).**
  The r8-5 hardening covered reading the fields once; a non-object descriptor
  still crashed (`Cannot read properties of null (reading 'caseId')`) at every
  entry point that reaches it (`build`, `hash`, `serialize`,
  `escalationRequestToMachineEvent`). A non-object descriptor is now the typed
  `not_object` refusal the wire already uses for a non-object body.
- **New: an independent implementation and a 100 000-case differential for the
  wire (round 49).** `scripts/differential/wire_ref.py` is a Python 3
  (stdlib-only) reimplementation written from the prose, and
  `scripts/differential/run.mjs` drives both over a seeded corpus comparing
  accept/refuse, the refusal CLASS, the preimage bytes, the digest, the
  canonical wire string and the mapped `escalate` event. Result: 4 distinct
  disagreements on v0.14.2 (the two above, plus two class-only), 0 after the
  fixes; 51 252 accepted requests agree byte-for-byte. The three
  under-specified corners it forced a decision on — the exact whitespace set,
  the BOM-stripping canonicality round-trip, and numeric literal portability —
  are written down in `docs/DIFFERENTIAL_WIRE.md` §5 and pinned on both sides.
  `__tests__/differentialWire.test.ts` runs the harness in its 2 s fast mode.

### Fixed (review-round-9 — the round-8 fixes attacked)
- **`caseId` was still FOLDED, so two ids shared one digest (r9-1,
  exploitable).** r8-1 rejected surrogates, NUL and >256 bytes and then returned
  `value.trim()`: `"court:X "`, `"court:X\t"` and `"court:X\u{3000}"` were one id
  with **one** request hash — the r7 H-6 collision that r8-1 was written to
  close, one `String.prototype.trim` away — and `build` returned an id the caller
  never supplied (the r8-5 shape). The host binding folded symmetrically
  (`expectedCaseId.trim()`), so "a request must not cross cases" held only up to
  the whitespace class. Ids are now validated **exactly** — leading/trailing
  whitespace is a typed refusal, canonicality is checked on the raw value, and
  the preimage no longer trims. **Consumer impact:** a case id with surrounding
  whitespace was previously accepted (folded) and is now refused; no generated id
  carries one, and the refusal is loud at build time rather than silent in a
  digest.
- **`bondTxid` was in the preimage and outside the binding (r9-2).** The mapper
  selects the challenge by `bondProofHash` and never compared `bondTxid` with the
  case, so a bonded challenger could name any txid and the logged `requestHash` —
  the append-only log's only record of the request — committed to a bond the case
  never bound (the r8-2 unverified-claim family on the field r8-2 forgot). It must
  now equal the `CourtChallengeRecord.bondTxid` its witness selects.
- **A CONCESSION was minted as an ESCALATION (r9-3).** `concession: true` is
  parsed strictly (r8-3) and committed to the hash as `'1'`, and the mapper then
  ignored it: an escalate event was minted from a request whose signer dropped the
  appeal, the reducer accepted it, and `escalationLog` recorded an authorisation
  the challenger refused while his exit (finality) was blocked and a fresh round
  bond was charged. A concession is now a typed refusal that names the `concede`
  transition.
- **The r8-6 history rule read one of the case's two round counters (r9-4).** The
  state carries `ladderRound` and `ladder.round`; every rung transition reads the
  first and the r8-6 length rule read the second. A snapshot with
  `ladderRound = 4`, `ladder.round = 2` and one history record passed the length
  check and appended round 2 — the "history no later barrier accepts" harm r8-6
  exists to refuse, after which the escalated round bond is already consumed (the
  r40-2 brick, reached through the guard added to prevent it).
  `onResolveRound` now requires the two counters to agree, and the escalation
  mapper refuses the same snapshot.
- **The 2 000-id "injectivity pin" measured sha256, not the encoding (r9-5).**
  Its generator (`court:market-r48:${i}`) produces ids with no surrogate, NUL,
  length or whitespace risk, so the sweep passes on the pre-fix code and on a
  deliberately lossy encoder (measured: 2 000 ids → **1** distinct digest). It is
  kept as a smoke test and joined by a differential pin over the **preimage
  bytes** — dangerous pairs must differ, the fold family must be refused.
- `__tests__/reviewRound9.test.ts` (27) — the encoding edge sweep (surrogates at
  seven positions, NUL at four, the 256/257 byte boundary at 1/2/3/4-byte widths,
  overlong UTF-8, NFC/NFD), the binding attacks (`bondTxid`, concession, echoed
  binding, derivable witness, cross-case), the duplicate-key depth argument, and
  the `resolve_round` lags: **8 red on v0.14.1**, 27 green here.
  `docs/REVIEW_ROUND_9.md` records attack → repro → measured outcome →
  disposition per target, and pins three REGISTERED residuals with named owners
  (the binding is a trust anchor a host can fill from the wire; bond ownership is
  still the host verifier's, so r40-3 is not preempted; the case state carries no
  case identity). Suite **1,831 passed / 1 skipped (82 files + 1 skipped)**.

### Tests (mutation campaign 3 — the v0.14.0 escalation TRANSPORT)
- **24 new mutants in 12 new classes** aimed only at `courtEscalationRequest.ts`
  — the first campaign to touch the file (campaigns 1–2 predate it). The classes
  are the codec's published claims: `caseId` injectivity (r8-1/r9-1), the digest
  over the re-validated request with the `'-'` witness sentinel, unknown-field and
  duplicate-key refusal (r8-4), no field coercion, the round ceiling, the
  identity/index/case binding (r8-2), bond ambiguity (r38-1), the signed round,
  host-clock authority, snapshot purity (r8-5) and the signed flag (r8-3).
  Catalogue **98 mutants / 40 classes**.
- **Measured twice, because the base moved.** As found on v0.14.1 (`bc28ff3`, the
  code the question was about): **78.3 %** (18/23 corrected), detector A only —
  the probe detector scored **0/23 because it never imported the file**. On the
  shipping head (v0.15.1) after closure: **23/24 corrected (95.8 %)**, with one
  **equivalent** mutant (M82, whose fold r9-1 made unreachable). Review round 9
  independently found and fixed two of the five survivors while this campaign ran.
- Closures **C11–C15** (`__tests__/mutationClosuresV014.test.ts`), each verified
  RED against its mutant applied to a sandbox copy.
- Detector C grew by **16 probes (S33–S48)**, one per transport claim, including
  an independent recomputation of the digest and a wire-injectivity corpus.
- Catalogue housekeeping (`scripts/mutation/**`): three-digit ids ordered
  numerically (the catalogue passed M99); **M65 re-anchored** (the r40-1 barrier
  moved its `find`, so `check-catalogue` had begun exiting 1 for the whole
  catalogue); **M67–M70 retired** to `RETIRED_MUTANTS` (r52 replaced the code they
  edited); **runner SIGTERM fix** — `cleanup()` is a single-flight promise and
  children are spawned detached, so the process group dies before the sandbox is
  removed (a leaked sandbox survived a SIGTERM before this).
- Two recorded captures in the evidence are load flakes in multi-process
  harnesses (`r30MultiProcessCeremony`, `r33ByzantineRelay`); both are disclosed
  with their reproduction in the campaign document rather than doctored away.
- Method, mutant table, per-detector scores and the honest reading of the
  transport's pinning: `docs/MUTATION_TESTING_V014.md`.

### Fixed (review-round-8 — the escalation transport and the r41-1 barrier attacked)
- **The transport bound nothing: three unchecked wire claims (r8-2,
  exploitable).** `escalationRequestToMachineEvent` filled `challengerIdx` from
  the bond owner and then forwarded the wire's `challengerPubkey`, giving the
  impression it had verified a pairing it cannot see — `CourtConfirmationMachineState`
  carries indices, not pubkeys (r29-5). Measured on v0.14.0: a bonded challenger
  minted an escalation the reducer accepted whose append-only `escalationLog`
  named **juror 3's** pubkey (attribution forgery, the r29-2 harm at mint time);
  a request signed to escalate past round 1 was accepted at round 3
  (`roundIndex` comes from the case, the wire's `round` was inert — replayable on
  every rung of a legacy case, where nothing is consumed); and a request for one
  case reduced on another (`caseId` was in the hash but never compared). The
  mapping now requires the host's `CourtEscalationBinding` — the case id it
  ROUTED on and the pubkey NIP-98 PROVED — and refuses a request that disagrees
  with either, or whose `round` is not the round being resolved. An ambiguous
  bond ledger (one hash, two owners on a restored snapshot) is refused rather
  than resolved by `Array.find`. **Consumer impact:** source-compatible (the
  fourth parameter is optional in the type) but behaviour-breaking by design — a
  3-argument call now throws instead of minting an unbound escalation. No
  downstream consumer exists yet (the vendored `@bao/frost-court` is 0.7.2);
  `PER_ROUND_BOND.md` states the requirement.
- **`caseId` was encoded lossily, so two requests could share one hash (r8-1,
  exploitable).** The preimage is `TextEncoder`-encoded, and an unpaired UTF-16
  surrogate is replaced by U+FFFD — so `"…:1\uD800"` and `"…:1\uFFFD"`, two
  different ids and two different wire strings, produced the **same** request
  hash (measured: `6fbca7ac…` for both). That is the r7 H-6 collision (one
  digest, two meanings) one field over, on the value hosts dedupe and audit by.
  `caseId` is now canonical UTF-8, `U+0000`-free and bounded at 256 bytes
  (`MAX_ESCALATION_CASE_ID_BYTES`), which makes the encoding injective over the
  accepted domain (pinned with a 2 000-id sweep).
- **`concession` was read as a truthiness test (r8-3).** `"true"`, `1`, `"yes"`,
  `{}`, `[]`, `null` all parsed to `false`, dropping a signed flag while the hash
  committed to `'0'`. A non-boolean is now a typed refusal, at `parse` and at
  `build`; absent still means `false`.
- **`parse` resolved duplicate JSON keys silently (r8-4).**
  `{"roundBondProofHash":null,"roundBondProofHash":"<real>"}` is one request to
  the codec and two claims to anyone reading the body (`JSON.parse` keeps the
  last). The string form is now scanned at depth 1 and a repeated field — after
  decoding, so `"c\u0061seId"` counts — is a typed refusal. An already-parsed
  object cannot be checked; hosts must hand `parse` the body text.
- **`build` validated one `caseId` and returned another (r8-5).** Each field was
  read twice, so a getter/`Proxy` could fail the emptiness check on one value and
  populate the request with another, and a non-string second read escaped as a
  raw `TypeError` instead of this module's typed refusal. Every field is now
  snapshotted exactly once before any check.
- **`resolve_round` appended onto a history that outran nothing (r8-6).** A
  restored `ladder_vote_closed` snapshot with `ladderRound = 4` and one record
  resolved and appended round 4, producing `[1,4]` — a history **no later barrier
  accepts**, so the case could never finalize again (the r40-2 brick, value
  locked). `onResolveRound` now requires
  `outcomeHistory.length === ladder.round − 1`, which the live path always
  satisfies. A legal two-round ladder still resolves `[1,2]` (pinned).
- `__tests__/reviewRound8.test.ts` (34) — the two exploitable closures, the four
  PARTIAL closures, the four finality paths re-attacked from the outside, the
  registered consistent-forgery boundary, and the over-strictness controls:
  **13 red on v0.14.0**, 34 green here. `docs/REVIEW_ROUND_8.md` records the
  attack, repro, measured outcome and disposition per target, and confirms the
  four r41-1 closures are real pins (4 red on `1b33b2f`, pre-#112). Suite
  **1,804 passed / 1 skipped (81 files + 1 skipped)**.

### Added (review-round-7 H-6 — the escalation request wire)
- **`courtEscalationRequest.ts` — the challenger's escalation request as a
  versioned wire codec, carrying the per-round bond witness.** The machine has
  accepted `roundBondProofHash` since R31 and the strict policy is the default
  for new cases since v0.13.2, but the artefact a client could actually SUBMIT
  had no field for it: the host's escalate body is
  `additionalProperties: false` without a round-bond property, and the request
  hash preimage omitted it. So a strict case's escalation was refused no matter
  what a client sent (transport could not precede enforcement — H-6), and two
  different round bonds would have hashed to one request hash. New surface:
  `buildCourtEscalationRequest` (validate + normalise),
  `serializeCourtEscalationRequest` / `parseCourtEscalationRequest` (canonical
  JSON, strict about unknown fields — a dropped field is the defect, not a
  default), `courtEscalationRequestPreimage` /
  `hashCourtEscalationRequest` (**domain v2**, witness in the preimage, `'-'`
  sentinel for its absence), and `escalationRequestToMachineEvent` (the
  reducer's `escalate` event field-for-field: the wire supplies the
  challenger's claims, the CASE supplies `challengerIdx`, `roundIndex` and
  `now`). Tests: `__tests__/escalationRequestWire.test.ts` (12) — round-trip,
  the strict wire-refusal matrix, the strict path ACCEPTING a transported round
  bond, the hash binding the witness, a pinned known-answer digest, and the
  doc pin.
- **`docs/PER_ROUND_BOND.md` — the compat matrix now states the order of
  operations explicitly**: the transport must carry the witness BEFORE the
  policy requires it, and the host's body schema + request hash must adopt the
  v2 shape together.

### Added (docs)
- **Paper + evaluation refresh (round 45) for review rounds 7–8 and v0.14.x.**
  `docs/FROST_COURT_ORACLE_PAPER.md` now carries the two severe finds of the
  period — **r41-1** (§6.1's three-ledger barrier and the derived verdict, §6.3's
  derivation-from-history rationale) and **r8-1** (§6.2, §10.2-Q) — plus the
  **v0.14.0 escalation transport** and its required `{caseId,
  authenticatedPubkey}` binding (§6.2), the realised-β gate drift (H-1) and the
  frozen-depth clamp (H-3/H-5) in §8.4, the preemption residual (r40-3) in the
  same section, the canonicalisation class stated as a per-field rule in §11.6,
  a new §12 gate 9 (the transport must be wired before the strict policy is
  enforced), Appendix A.1 entries S-23/S-24, the r41-*/r8-*/H-* rows in A.3, and
  the 1,804-test count in §11.1/A.4. `docs/EVALUATION.md` gains four audit rows
  (rounds 5–8), the re-attack totals, the canonicalisation and attribution
  classes, and the per-round suite ledger to `bc28ff3`. `docs/REVIEWS_INDEX.md`
  indexes rounds 7–8, the v0.14.0/v0.14.1 releases, and a **ninth** failure
  class — identifier canonicalisation, with its three instances (the pre-mainnet
  surrogate collision, H-6, r8-1) and the rule they teach. **Docs only** — no
  code, fixture or test touched; `npm test` 1,804 and `cross-check.mjs` exit 0
  re-verified on this head.

- **`docs/REVIEWS_INDEX.md` — the map of the self-verification campaign.** Every
  review/simulation round in order (improvement 1–4, symposium 5–21, the
  2026-11-10 GPT/Claude/Gemini reviews, review rounds 2–6, instrument rounds
  29–37), per round: attack surface, findings by severity, fix (PR + release),
  and residual disposition; the **eight-class failure taxonomy** (trust-boundary
  pinning, state-restore divergence and its over-strictness mirror,
  bond/economics binding, report-vs-decision mismatch, vacuity, flood/eviction,
  attribution); and every headline number with its artifact. Cross-referenced
  from `README.md`, paper §11.6 and `CROSS_CHECK.md`. Docs only — no code, no
  fixture, no test touched.

### Fixed (review-round-7 — v0.13.2 and the R41 host fixes attacked)
- **`finalize` minted a verdict from a vote ledger it never re-derived (r41-1,
  exploitable).** For a challenged case the verdict's evidence is the last
  round's VOTE ledger (`state.ladder.votes` → `supportingEventIds` → the hash
  preimage). `resolve_round` re-derives that ledger, but a restore skips
  transitions, and `finalize` validated the confirmation ledger, the outcome
  history and the escalation log — not the votes. Round 6's entry matrix even
  recorded `concede` as a non-reader "followed by a pool-reading barrier": true
  of the challenge pool, false of the pool `finalize` reads. Repro: park a
  restored snapshot at `fee_settlement` (through `concede`), replace the
  deciding round's ballots with one forged vote plus a matching pending verdict,
  and `finalize` returned `final` with that outcome and a canonical
  `verdictHash` — the market pays the losing side of a case both panels voted
  against. Duplicate ballots inflated the support set, and a malformed event id
  escaped as the *vote* machine's `CourtVoteTransitionError` instead of this
  machine's typed refusal. `finalize` now runs `assertValidMassVoteLedger` and
  derives the verdict from the round's append-only `outcomeHistory` record,
  requiring the vote ledger to agree with it (round, majority, and the exact
  winning event-id set). **Consumer impact:** none for legal states — a 40-flow
  walk (both policies × both authorities × depths 1–5 × never-challenged)
  finalizes identically and mints identical hashes; a host that restored a
  tampered snapshot now gets a typed refusal where it used to get a settled
  verdict.
- **`verdict.upheld` was copied from the snapshot, not derived (r41-1,
  same root).** The flag is not in the verdict-hash preimage, so a restored
  snapshot could flip it and change the meaning of a verdict whose hash still
  verified. `finalize` now derives it (`record.outcome === proposedOutcome`) and
  refuses a pending verdict that disagrees.
- `deriveMaxLadderRounds`' docstring said "monotone non-increasing in `a_f`" —
  the direction is the opposite (measured: caps 0…5 as accuracy runs 0.30…0.95;
  a less accurate jury gets a SHALLOWER ladder). Corrected, with the grid pinned
  (r41-T1-doc). `docs/PER_ROUND_BOND.md` gains the entry-matrix correction
  (which pool `finalize` reads) and an upgrade checklist for the strict
  round-bond policy; `docs/FORMAL_INVARIANTS.md` INV-CONF-32/32b keep up.
- `__tests__/reviewRound7.test.ts` (19) — the four r41-1 closures (all red on
  the previous head), the non-reader probes, the over-strictness walk, the
  sign-rule edge probes and two doc pins. Suite **1,758 passed / 1 skipped
  (79 files + 1 skipped)**.

### Fixed (review-round-6, the round-5 and round-37 fixes attacked)
- **A restored challenge ledger bought a FREE rung at `escalate` (r40-1,
  exploitable).** Round 5 bound one `bondProofHash` to one roster index and
  taught `assertValidConfirmationLedger` the rule, but `onEscalate` ran only the
  *log* barrier: the r29-1 witness test reads `state.challenges`, so a tampered
  snapshot binding one hash to two indices satisfied `(idx, bondProofHash)` for a
  juror that posted nothing. The rung opened on a borrowed bond, a round panel
  was seated, and the case could then only brick at `resolve_round` (the ledger
  barrier) — r38-1's harm one entry later, plus a DoS. `onEscalate` now re-derives
  the challenge ledger before the witness is used.
- **`open_ladder_round` ran NO barrier, so a deleted escalation record still
  opened the rung (r40-2, exploitable).** `open_ladder_round` is the transition
  that actually spends a panel seat; it validated the round number, the cap, the
  deadline and the roster — and nothing else. A restored `ladder_pending` snapshot
  with `escalationLog: []` opened round k+1, un-consuming the bond that record
  paid with, and bricked at `resolve_round`. It now runs
  `assertValidEscalationLog` **and** `assertValidConfirmationLedger` first.
  **Consumer impact:** none for legal states (a 640-state legal-state hunt across
  every policy/ladder/authority combination is pinned, 0 refusals); a host that
  restored a tampered snapshot now gets a typed refusal *before* a panel is
  seated, where it used to get a bricked case after one.
- `docs/PER_ROUND_BOND.md` gains reducer rule 6 (the challenge-pool precondition
  the witness test rests on), the barrier's three call sites, the `ladder_pending`
  restore contract (r37-1) and the ownership boundary; `docs/FORMAL_INVARIANTS.md`
  INV-CONF-17/INV-ESC-8/INV-ESC-9 keep up; `CourtChallengeRecord.bondProofHash`
  now says **preemptable**, not merely collidable (r40-3: a derivable witness is
  first-come-first-served, so the host verifier must bind it to the event author).
- `__tests__/reviewRound6.test.ts` (23) — the two closures (6 red on the previous
  head), the barrier-at-every-entry matrix, the legal-state hunt, and the
  registered residuals. Suite **1,739 passed / 1 skipped (78 files)**.

### Fixed (review-round-5, the round-4 fixes attacked)
- **One bond witness bought two challengers' standing (r38-1, exploitable).**
  `accept_challenge` deduped the challenge ledger by `idx` only, so a juror that
  posted nothing could name a bonded juror's `bondProofHash` as its own, mint an
  "accepted" challenge with it, and then escalate — the `(idx, bondProofHash)`
  binding r29-1 added is satisfied once the borrowed record exists. That made the
  membership bond free for the first layer and undermined the premise of the
  r33-1 fix (which enumerates `state.challenges`, i.e. a pool that was not
  unique). `accept_challenge` now binds one proof hash to one roster index, and
  `assertValidConfirmationLedger` re-checks it on restored ledgers. **Consumer
  impact:** a host whose `bondProofHash` derivation collides across jurors (e.g.
  a hash of the funding transaction, which a batch payout shares) must mix the
  juror index into the witness; every per-juror proof is unaffected.
- `docs/PER_ROUND_BOND.md` now records the membership-pool uniqueness invariant
  and names the `requireRoundBond` × `hostEscalation` composition hazard
  (r38-2): the break-glass exemption is granted to *challenger* escalations too,
  so the two flags together price nothing.

### Fixed — round-37 mutation campaign on the v0.13 surface (r37-1)
`docs/MUTATION_TESTING_V013.md`. 25 hand-written mutants in 10 new classes
(per-round bond consumption, escalation-witness binding, `requireRoundBond`
strictness, ledger completeness, the sign-based ladder bound, penalty aging, the
weight anchor, the R25 policy flag, the 3^R bond schedule, κ). Pass 1 captured
24/25 (96.0 %); the single survivor (M66, the escalation-log round bound) is
**equivalent** — and investigating it found the defect below.

- **The restore barrier refused a LEGAL `ladder_pending` snapshot (r37-1).**
  `assertValidEscalationLog`'s completeness rule accounts for the half-step
  between `escalate` (which appends the record for `ladderRound + 1`) and
  `open_ladder_round` (which advances `ladderRound`), but its round-binding rule
  compared against `ladderRound` alone: a state produced by `escalate` (phase
  `ladder_pending`, `ladderRound` 1, one record for round 2) threw
  «escalation log records a round the case never opened». The reducer never
  calls the barrier in that phase, so no shipped path broke — but a HOST
  validating a restored mid-escalation snapshot (the documented restore path,
  INV-ESC-8) was refused by the barrier itself. The bound now includes the
  pending rung. **Consumer impact:** none for finalize/escalate; hosts that call
  `assertValidEscalationLog` on a pending snapshot gain the case they were told
  was legal.
- `__tests__/mutationClosuresV013.test.ts` (3) — the closure pins: a legal
  pending snapshot is accepted (fails before the fix), a forged round is still
  refused, and a log longer than the opened rounds is still refused.
- `scripts/mutation/check-catalogue.mjs` — proves the whole catalogue applies
  exactly once in ~1 s before a sweep.
- Verification on the rebased tree (round 5 in): suite **1716 passed / 1 skipped
  (78 files)**, catalogue 78/78 applicable, detector-C probes **32/32**, and the
  pass-2 sweep re-run so the recorded verdicts describe the shipping code.

### Added — the v0.13 mutant catalogue and its detectors
- `scripts/mutation/mutants.mjs`: **M54–M78** (25 new mutants, 10 new classes;
  catalogue is 78 in 28 classes). Ids are permanent.
- `scripts/mutation/spot-check.mjs`: **S19–S32**, one black-box probe per v0.13
  invariant (INV-ESC-8/9, 02-ladder Thm 2, 06 §1.5/§3/§4, INV-CONF-4). Detector
  C fires on 19 of the 25 new mutants; detector A on 23; the model explorer on
  1 (its honest denominator is the 6 machine-attached mutants).
- Committed run outputs: `scripts/mutation/pass1-v013.json` (as found) and
  `scripts/mutation/pass2-v013-postclosure.json` (after the fix), each with the
  per-mutant verdict, which detectors fired, the failing test names and the
  clean-tree proof.
6c08e7c (test(mutation): round-37 campaign on the v0.13 surface — 25 mutants, 96%, and r37-1)

### Added — Byzantine-relay multi-process ceremony (R33)
R30 proved the ceremony survives process death and cross-round replay over an
**honest** relay. R33 removes that assumption: the loopback relay now keeps a
**per-juror view** (jurors poll with `?as=<idx>`) and can lie deterministically
under a seed — `reorder`, `drop`, `fork` (split-view, from DKG or from the
signing phase), `replay` (duplicate + late redelivery) and `silence` (targeted
censorship). Every routing decision is a hash of `(seed, mode, seq, juror)`, so
the same seed reproduces the same dishonest relay record for record.

- `scripts/court/multi-process-ceremony.mjs`: `--mode=`, `--drop-p=`,
  `--reorder-window-ms=`, `--reorder-style=block|invert`, `--fork-variant=dkg|sign`,
  `--victim-idx=` (silence/invert target) and `--matrix` (15 cells: every mode at N=3 and N=5, ≈40 s).
  Each run writes `relay-views.json` (what each juror actually saw) and a
  machine verdict in `report.json#equivocation`.
- The equivocation assertion, applied to **every** mode: at most one distinct
  signed message, at most one distinct group key across outputs, every emitted
  signature verified by the coordinator against the key it recomputed from the
  receive log, and a completion shape that is either `ALL_COMPLETED_IDENTICALLY`
  or `ALL_FAILED_CLOSED` (a `PARTIAL` shape is allowed only where loss makes it
  unavoidable, and must stay non-equivocating).
- Result: **NO_EQUIVOCATION** in all 15 cells. A split view cannot produce two
  signatures over different messages — and cannot produce one either: the
  full-roster DKG key computation plus the roster-wide reveal gate
  (`createMyReveal` needs every participant's commitment; `canAggregate` needs
  reveals == commitments) starve both halves. Findings F1–F4 (arrival-order
  sensitivity of the reveal gate, blame = "whom I did not hear from",
  all-or-nothing liveness, legal `PARTIAL` completion) are registered in
  `docs/MULTI_PROCESS_CEREMONY.md`.
- `__tests__/r33ByzantineRelay.test.ts` (8 cases, ≈20 s) gates the matrix
  properties; `npm run simulate:byzantine`.

## [0.15.3] — 2026-11-12

### Fixed (r12-1 over-strictness — found by the host sync, not by a review)
- **The counter barrier refused every legal host LANE snapshot.** r12-1 added
  "no `ladder` ⇒ `ladderRound` must be 0". That clause is true of every state
  the machine produces and false of the `bao.markets` escalation lane, whose
  persisted slice is a `Pick` of `CourtConfirmationMachineState` (phase, counter,
  policies, roster, ledgers) and **no `ladder`** — the ladder in that deployment
  is the case row's (`market_disputes.dispute_round`). Measured on the host's
  v0.15.2 vendor sync (PR #2488): **42 of 185 court tests red across 8 suites**,
  including R50's first-contact escalation; green at v0.15.1, and reverting only
  that clause made 52/52 green. It is the r37-1 class a third time: an invariant
  stated as *shape* ("there is no ladder object") when it means *provenance*
  ("whose ledger vouches for this round").
- **Fixed by declaring provenance, not by reverting the clause.** New
  `projection?: 'lane'` on the state (`CourtConfirmationStateProjection`): absent
  on every state the factory and the reducer produce — so "absent" means the FULL
  machine state — and `'lane'` on a host projection. `assertRoundCountersAgree`
  now takes a **required** reader (`RoundCounterEntry`): a declared lane at
  `ladderRound ≥ 1` with no ladder is accepted by `escalate` (which opens
  `ladderRound + 1`, the rung no ledger covers yet, and whose log barrier sizes
  itself from the same counter) and by the transport mapper that mints that event
  (one rule, not two — r9-4 reuses the barrier), and refused by
  `open_ladder_round`, `resolve_round`, `flag_clawback` and `finalize`, so a
  projection can never persist a round or mint a verdict. The write domain
  (non-negative safe integer) is unchanged on **both** shapes. Escalating does
  not launder a projection into a full state (the marker survives the spread), an
  unknown marker is a typed refusal at the reducer's front door, and the mapper
  no longer demands a `ladder` record.
- **Both directions proven** (`__tests__/overStrictness.test.ts`, 25 tests):
  (a) r12-1's exploits still fail — a forged counter (hostile string, `2.5`,
  `-1`, `null`, `NaN`, `2^53`) is refused on a lane projection too; a full state
  with a counter and no ledger is refused; a lane projection re-stamped into
  `fee_settlement` / `ladder_vote_closed` / `ladder_pending` reaches **no** write
  path and writes nothing; an unknown/stripped marker closes the door. (b) the
  host's exact G-4 shape (`buildCaseMachineLaneState`, reproduced field for
  field) escalates from round 1 and from a later rung, and the mapper mints the
  same event from the same state.
- **New standing over-strictness suite** — the class that keeps recurring:
  a shape × reader MATRIX over 12 legal host shapes (lane first contact, lane at
  a later rung, lane mid-escalation, the older wire projection, the machine's own
  state at every phase, the legacy shapes), every cell asserted in **both**
  directions; plus a sweep that requires every exported `assert(state)` in
  `confirmationMachineCore` to accept the lane unless the sweep's allow-list
  names it with the reason — a new barrier can no longer re-strict a legal host
  shape silently.

### Changed
- `courtEscalationRequest.ts` calls `assertRoundCountersAgree(state, 'transport')`
  instead of re-deriving "one round number per case" (r9-4 stays one
  implementation; a lane projection with a forged counter now fails the domain
  check here too).
- Docs: `docs/LANE-PROJECTION.md` (the host-facing contract), INV-CONF-37 in
  `docs/FORMAL_INVARIANTS.md` + its row in `docs/CROSS_CHECK.md` (286 claims),
  and the glossary entry in `CONTEXT.md`.
- Suite **2,008 passed / 93 files** (1 env-gated live test skipped; +25 in this
  release) and `cross-check` **286 claims / 521 refs**; the three typechecks and
  `simulate:court` are unchanged.

## [0.15.2] — 2026-11-11

### Fixed (review-round-12, PR #131)
- **The echo path was total over two files of four (exploitable).** A mechanical sweep discovers every site that interpolates a value into a typed refusal; on `v0.15.1` it finds **66 raw sites** (44 in `confirmationMachineHandlers.ts`, 9 in `confirmationMachineCore.ts` incl. `state.ladderRound`, 3 in `courtConfirmationMachine.ts` incl. the front-door `event.type`, 10 in `courtEscalationRequest.ts`). Measured: `Object.create(null) as event.type` threw a raw `TypeError` **and ran caller code inside a refusal**; a newline in an outcome was echoed verbatim. Fixed with one shared escape module (`courtEcho.ts`), a runtime-total `quoteWireValue`, and a **static test that fails on any future raw site** (with a teeth test and a one-implementation assertion).
- **The counters barrier accepted agreement as integrity.** Two counters forged to the SAME non-integer passed the `===` check and `flag_clawback` persisted the forged round (`{"round":"3\nESCALATION ACCEPTED…"}`, `{"round":2.5}`). The barrier now enforces the counters' write domain.
- **The echo clip** was documented as 64 characters and returned 65, and counted UTF-16 units (40 astral characters measured 65; now 63).

### Changed
- Round-12's mechanical totality sweep, the 20,000-shape fuzz of the event validator (zero raw throws; the three narrowings vs nostr-tools are pinned as decisions), and the note that object spread copies nostr-tools' memoised `verified` symbol — so the binder's rebuild is load-bearing.
- The round-11 parameter-rationalisation divergence is **closed by design**: `String(x)` *is* the shortest round-trip decimal, so no lossless merge exists; the obligation is to pass the literal decimal.
- Suite **1,953 passed** (90 files, per the clean-runner CI battery — the local count was 1,951 on a CPU-contended host); mutant catalogue 101.

## [0.15.1] — 2026-11-11

### Fixed (review-round-11, PR #128)
- **`quoteWireValue` was not total (three exploits):** four call sites escaped but ten exist — `event.kind` from the wire and `state.ladderRound`/`state.phase` from a snapshot were raw, so a restored `ladderRound: "3\nESCALATION ACCEPTED"` **forged a log line inside the barrier's own refusal message**. The documented 64-char bound was also spent on the *input*, so a legal 60-char zero-width id produced a 387-char echo (now 59); and `String(Object.create(null))` threw a `TypeError` **out of** a refusal (`quoteWireUnknown` now never calls `toString`).
- **`verifyEvent` ran on an unvalidated event:** `tags: null` raised `Cannot read properties of null (reading 'map')`. The shape is validated first.
- **`flag_clawback` was the one ladder reader the round-10 sweep missed** — it wrote a round-3 clawback on a round-2 ladder. Now behind `assertRoundCountersAgree`.
- Message honesty (a string `kind`), and the core comment that described a reverted pre-dispatch placement.

### Changed
- Suite **1,932 passed** (86 files).

## [0.15.0] — 2026-11-11

### Changed (semantics — the exported ladder bound)
- **`deriveMaxLadderRounds` IS the safe predicate** (r52, closing the off-by-one round 46a's mechanisation exposed): it returns `max{d : R·D^d < A^d·(R+B)}` evaluated in exact `BigInt` on the rational each parameter names — no logarithm, no float comparison on the decision path, `0` = no safe depth. At exact-integer boundaries (`a_f = 1/2` with `β = 3ρ`, `7ρ`, `15ρ`, `31ρ`; `3/4` with `β = 7ρ/9`) the old value named the **break-even** round that the sign gate already refused. Seven rows change; all non-boundary rows are unchanged (flip 7/5/4/3/2, cap 5/4/3/2/1). `derivedCap = flipRound − 1` is now an equality everywhere, and `ρ+β` overflow no longer reads as a perfect jury.

### Added
- **Mechanised escalation layer** (`proofs/lean4/LadderBound.lean`, `EscalationLedger.lean`; `proofs/mechanized/escalation.qnt`): `safe_depth_bound` (`E[π](d) < 0 ↔ d < flipRound`, reduced to the integer inequality), `safe_monotone`, `unsafe_witness` (the ladder is not a free option), `one_hash_one_index`, `consumed_not_reused`, `round_bond_not_membership`, `strict_case_has_round_bond`, `rounds_consecutive`, `escalation_opens_next_round`, `log_length_bounded`, `reachable_wellFormed` (barriers never refuse a legal history). **No `sorry`; axioms `propext` and `Quot.sound` only.** Apalache exhaustive (depth 10/8) with 58 Quint scenarios; a `file:line` code↔model correspondence table in `docs/proofs/07`.
- **Independent wire implementation + differential** (`scripts/differential/`, `docs/DIFFERENTIAL_WIRE.md`): a Python reference written from the spec reproduces the known-answer digest independently; 100,000-case differential, 51,252 accepted requests byte-identical, 0 disagreements after the fixes below.
- **Campaign 10×**: 1,587,000 units / 8,286,823 assertions / 0 failures (`docs/benchmarks/SCALE_CAMPAIGN_V2.md`).

### Fixed
- Four raw `TypeError` escapes found by the differential (non-array `challenges`, `null` ledger row, `build(null)`, `build([])`).
- **Review round 10** (PR #122): the refusal path echoed wire values verbatim, so a crafted id forged a log line inside the refusal document (`quoteWireValue` now escapes `Cc/Cf/Zl/Zp/Cs` and bounds the echo); a **signed concession re-presented with `concession:false` was hashed as an escalation nobody signed** (the binding now lives inside the signed bytes — kind, id, signature, author, `created_at`, content); `finalize` read `ladder.round` for the verdict and `ladderRound` for the log, so a skewed snapshot **finalised round 2's YES over round 3's NO** (`assertRoundCountersAgree` in `finalize`/`escalate`/`open_ladder_round`).

## [0.14.2] — 2026-11-11

### Fixed (review-round-9, PR #118)
- **`caseId` was still `trim()`-folded (exploitable):** `"court:X "`, `"court:X\t"` and `"court:X\u3000"` hashed to one digest, and `build` could return an id it was never given; the host binding folded symmetrically, so "must not cross cases" held only across the whitespace class. Ids are now validated exactly (whitespace refused), the preimage never trims, and the binding compares exactly.
- **`bondTxid` was never compared with the challenge record** — the logged `requestHash` could commit to a bond the case never bound.
- **A signed concession could be minted into an escalation** (the reducer accepted it and the log recorded a refused authorisation; the exit then blocked and demanded a fresh round bond).
- **`ladder.round` vs `ladderRound` skew** — the finality rule read one field while every rung transition reads the other, so a skewed ladder appended a wrong record (and then bricked the case).
- **A vacuous pin:** the 2,000-id injectivity check passed for a deliberately lossy encoder (one distinct digest). Replaced by a preimage-byte differential pin.

### Changed
- Paper + docs refreshed for review rounds 7-8 (PR #117): the `concede`→`finalize` finality forgery, the surrogate collision, the wire binding, and the canonicalisation failure class (three instances, one rule: canonicalise once, per field, with a differential pin).
- Suite **1,831 passed** (82 files).

## [0.14.1] — 2026-11-11

### Fixed (review-round-8, PR #115)
- **`caseId` encoded lossily (exploitable):** `TextEncoder` maps an unpaired surrogate to U+FFFD, so `"…:1\uD800"` and `"…:1\uFFFD"` — different ids on different wires — hashed to one digest (the H-6 collision one field over). Escalation-request ids are now canonical UTF-8, NUL-free and ≤256 bytes, with a 2,000-id injectivity pin.
- **The wire's `challengerPubkey` forwarded uncompared (exploitable):** a bonded juror could write another juror's pubkey into the append-only escalation log (mint-time r29-2 harm); a request signed for round 1 could open round 4 (the wire `round` was inert); a `caseId` could cross cases. The mapper now requires a host-supplied `{caseId, authenticatedPubkey}` binding and `round === ladderRound`; ambiguous bond ledgers are refused.
- `concession` truthiness, duplicate JSON keys (last-win), and a double `caseId` read (raw TypeError) in the builder.

### Changed
- The round-7 finality barrier is verified blocked on all four paths to `finalize`; `resolve_round` no longer bricks a case when it appends onto a lagging history.
- Suite **1,804 passed** (82 files).

## [0.14.0] — 2026-11-11

### Added
- **Escalation request transport (`courtEscalationRequest.ts`, `@bao/court/escalation-request`):** `build`/`serialize`/`parse` (strict unknown-field refusal) carrying the per-round bond witness on the wire, a v2 hash binding `roundBondProofHash` (`'-'` sentinel when absent), and `escalationRequestToMachineEvent` filling the reducer's `escalate` event field-for-field (the wire supplies the challenger claims; the case supplies `challengerIdx`/`roundIndex`/`now`). This is the prerequisite the strict round-bond mode needed: transport ships, then enforcement. 12 tests incl. a pinned known-answer digest.

### Fixed (review-round-7, PR #112)
- **`concede` → `finalize` forged a verdict (exploitable, most severe of the campaign):** `concede` reached `finalize`, which read the vote ledger without the mass-vote barrier — measured on v0.13.2: `FINAL outcome=MAYBE supported=3` on a case both panels voted NO, with `upheld` caller-supplied and absent from the hash. The barrier now runs, the verdict is derived from the round's `outcomeHistory` with vote-ledger agreement, and `upheld` is derived. 4 closures were red before the fix; 40/40 legal flows unchanged.
- The `a_f` direction in the bound docstring was backwards (non-decreasing in `a_f`); fixed and pinned.

### Changed
- Suite **1,770 passed** (81 files).

## [0.13.2] — 2026-11-11

### Fixed (review rounds 4–6 + mutation campaigns)
- **Bond/one-challenger binding (r38-1):** `accept_challenge` deduped by index only, so an unbonded juror could mint an accepted challenge carrying a bonded juror's `bondProofHash` and escalate on it — one payment, unlimited standing. The reducer and the challenge-ledger barrier now bind one proof hash to one index.
- **Escalation barriers on every entry (r40-1, r40-2):** `onEscalate` ran the log barrier but not the challenge-ledger barrier, and entering `ladder_pending` directly ran no barrier; a restored `ladder_pending` with its record deleted opened a rung and un-consumed its bond. The entry matrix now pins five readers (three non-readers are stated).
- **Legal mid-escalation snapshots (r37-1):** the escalation-log round bound ignored `ladder_pending`, refusing legal restored states. Fixed; the legal-state hunt (490 states) is clean.
- **Sign-based ladder bound (r33-6 / r40-4):** the host composes the sign rule, not `cap <= derivedCap` (reachable-wrong at β≠ρ).

### Added
- Mutation campaign 2 (25 mutants, 96%, probe-only capture of the sign-cap mutant; catalogue 78 mutants / 28 classes), review rounds 5–6, `MUTATION_TESTING_V013.md`, `COURT_ROUND_BOND_POLICY.md`.
- Suite **1,739 passed** (78 files); the round-bond strict mode is the default for new deployments.

## [0.13.1] — 2026-11-11

### Fixed (review-round-4, PR #103)
- **Two-challenger bond billing (r33-1, exploitable):** the reducer compared the round bond only with the escalator's own membership bond, so juror B could bill its rung to juror A's accepted challenge bond (A's witness burned, B free, wrong payer logged). The reducer and the finalize barrier now refuse ANY already-accepted challenge bond.
- **Short escalation log un-consumed bonds (r33-5, exploitable):** deleting a log record freed its bond — a restored snapshot could open a free rung (then brick the case at finalize). The ledger must now be complete (one record per opened round), and `onEscalate` re-runs the barrier before any rung opens.
- **Profitable round blessed when `a_f ≤ ½` (r33-6, exploitable):** the derived-bound clamp admitted the first profitable rung; `0` now means no safe depth, and the ok-test is sign-based.
- `Infinity` from finite overflow in the penalty arithmetic (r33-9).

### Changed (docs + verification)
- Paper + evaluation refreshed with rounds 29–31 evidence (witness-aware sweep 15 instances / 3,869,232 states / 60,020,684 illegal-witness probes / 0 accepted), the Byzantine-relay equivocation matrix (NO_EQUIVOCATION — mechanism), and §11.6 "the review verifies itself".
- Registered-findings sweep: 107 items dispositioned (6 fixed / 46 closed-by-design / 53 deferred-v0.14 with triggers / 2 rejected); zero left registered.
- Readiness review: 3× READY-WITH-EDITS, 14 doc corrections; suite **1,686 / 76 files**; invariants 158; cross-check 285 claims / 516 refs / 95.1 %.

## [0.13.0] — 2026-11-11

### Fixed — the escalation bond is a consumption test, not a membership test (R31, r30-1)
`docs/proofs/economics/06-expert-verify.tex.md` §1 showed that one accepted
challenge bond authorised every ladder round (`ΔC_{r+1} = 0`): escalation was a
free option worth `Σ 3^r b₀` (363 b₀ at the protocol cap), eroding the
unmerited challenger's burn from −2.40 % to −1.86 % of V at the shipped cap and
to −0.543 % (a 77 % loss of deterrence) at the protocol cap.

- **Wire:** `CourtEscalationRecord.roundBondProofHash` + `escalate.roundBondProofHash`
  + the frozen policy `CourtConfirmationMachineState.requireRoundBond`. The
  reducer refuses a missing per-round witness on a strict case, a relabelled
  membership bond, and a hash an earlier round already consumed;
  `assertValidEscalationLog` re-derives all three rules at `finalize`, so a
  restored snapshot cannot re-open the option. **Consumer impact:** the new
  record field is additive and `requireRoundBond` defaults to `false` — existing
  cases, snapshots and hosts keep the v0.12 semantics. Full compatibility
  matrix: `docs/PER_ROUND_BOND.md`.
- **Economics module:** `ladderEconomics.ts` —
  `deriveMaxLadderRounds({a_f, rho, beta})` (the boxed cap rule of 06 §1.5,
  `floor(ln(ρ/(ρ+β))/ln a_f)`, clamped to the machine ceiling),
  `deriveLadderFlipRound` (the first *profitable* round: 7/5/3 at
  `a_f = 0.9/0.85/0.75`), `escalationOptionEv`, `ladderCapWithinBound`, and the
  per-round bond schedule (`ΔC_R = 3^R b₀`, cumulative 4/13/40/121/364×).
- **Decay pairing (r30-4):** `penaltyAging.ts` — `agePenalties(penalties, epochs)`
  ages a penalty at the SAME `λ = ln2/3` as the commitment, on the participating
  clock, and `pairedJurorWeight` anchors the decay at the floor. Idleness never
  hands weight back; recovery is bought with participation. Pinned against 06
  §4.2: the paired curve never exceeds the cliff it replaced (0.5000 flat at
  6/6) and is never worse than the shipped ramp (0.6298 at 6/6).

### Tests
- `__tests__/perRoundBond.test.ts` (12) — the compatibility matrix from the
  reducer boundary + three tampered-snapshot finalize refusals.
- `__tests__/ladderEconomics.test.ts` (12) — the published cap/flip/EV numbers
  and monotonicity, asserted by sign rather than by formula.
- `__tests__/penaltyAging.test.ts` (13) — the pairing, the cliff/ramp curves.
- Model checker P2 gains the consumption invariant; the witness fuzz corpus (W3)
  pins the recorded per-round bond.

## [0.12.1] — 2026-11-11

### Fixed (review-round-3, PR #95)
- **Escalation bond binding:** the reducer bound the bond hash to the CASE instead of the CHALLENGER — a juror holding no bond could escalate on a bonded juror's accepted hash, and the audit log named the wrong person. Now the challenge's index, challenger index and bond proof hash must all match (`challenge.idx === challengerIdx` ∧ hash match). The model checker's "independent" property had mirrored the same weak check (it agreed with the bug); the property is corrected.
- **`finalize` re-verifies the escalation log** (`assertValidEscalationLog`, INV-ESC-8): a restored snapshot can no longer append a fabricated witness record and mint a verdict on top. Short/absent logs remain accepted so pre-0.12 snapshots finalize (pinned).
- **Simulation budget pinned:** a mutant returning `Infinity` survived 23/23 budgeted tests (vacuous ceiling) — the ceiling is now asserted.
- **Witness-aware verification:** the full sweep regenerated with escalate events — 15 instances / 3,869,232 states / 213,521,172 applications; an illegal-witness matrix at every reachable state (60,020,684 probes, 0 accepted); `escalationLog` structurally bounded; terminals refuse perfect witnesses.

### Added (campaign artifacts)
- Round-29 corpora: witness fuzz (10k), epoch-rotation batches (1k/39 rotations), finality chains (5k) — campaign total **1,187,000 units / 3,745,566 assertions / 0 failures**.
- `docs/REVIEW_ROUND_3.md`.

## [Unreleased]

### Fixed — review-round-4 closures on the v0.13 surface (r33, `docs/REVIEW_ROUND_4.md`)
- **A per-round bond may not be ANY accepted membership bond** (r33-1,
  EXPLOITABLE): `onEscalate` compared the witness only with the *escalating*
  challenger's own challenge bond, so in a case with two bonded challengers juror
  B could quote juror A's accepted bond as its own per-round payment — burning a
  witness A still needed and billing B nothing. The reducer now refuses any
  `state.challenges[*].bondProofHash`, and `assertValidEscalationLog` applies the
  same rule at `finalize`.
- **The escalation log must be COMPLETE** (r33-5, EXPLOITABLE): the barrier
  deliberately accepted a short log (pre-0.12 snapshots), but the log is also the
  per-round bond CONSUMPTION ledger, so a restored snapshot with an entry (or
  every entry) deleted un-consumed the bond it paid with and the next `escalate`
  opened a free rung — then `finalize` bricked the case. One record per opened
  round is now required whenever the case has records, and unconditionally under
  `requireRoundBond: true`; `onEscalate` re-runs the barrier before a rung opens
  instead of waiting for `finalize`.
- **`deriveMaxLadderRounds` / `ladderCapWithinBound` no longer bless a profitable
  round** (r33-6, EXPLOITABLE): the clamp `max(1, floor(boundary))` reported a cap
  of 1 when the boundary was ≤ 1 (a jury at ≤ ½ accuracy, where round 1 is
  already profitable), and the pre-flight compared `cap <= derivedCap`, returning
  `ok: true` for exactly the round the economics forbids. The derivation now
  returns **0 = no safe depth**, and `ok` is decided by the sign
  (`maxLadderRounds < flipRound`), so `ok ⇒ E[π(cap)] < 0` holds for every input.
- **`pairedJurorWeight` refuses an overflowing bonus** (r33-9): finite `w0` ×
  finite `bonusMultiplier` could exceed `Number.MAX_VALUE` and return `Infinity`,
  which would dominate any lottery/selection comparison downstream; it now throws
  like every other non-finite input. The participating-clock provenance
  requirement (r33-8) and the `minWeightFactor: 1` penalty-erasure hazard
  (r33-8b) are documented in the module.
- **Consumer impact:** none removed; `deriveMaxLadderRounds` can now return `0`
  ("no safe depth"). Tests: `__tests__/reviewRound4.test.ts` (21 probes, 6 of
  them red on the unfixed base).

### Documentation — paper + docs refresh with the round-29…31 artifacts (round 32)
- **Paper** (`docs/FROST_COURT_ORACLE_PAPER.md`): witness-aware model checking in the
  abstract and §11.2 (15 instances / 3,869,232 states / 213,521,172 applications /
  **60,020,684 illegal-witness probes, 0 accepted**, plus MC-F7/MC-F8 as published
  fixture defects); new **§11.6 "The review verifies itself"** (the
  review-verifies-itself methodology, its grading rule and its limits, with the
  self-found defect table: r29-1, T-1, r30-1, r29-10, SOAK-F8) and **§11.7
  "Evidence at scale, across processes, and over time"** (1,187,000-unit corpora, the
  three-day soak with SOAK-F7/F8/F11, T-1, and the multi-process ceremony with its
  honest localhost scope); §8.4 gains the per-round bond (consumption vs membership,
  ΔC_R = 3^R b₀, the free option worth 363 b₀) and the derived ladder cap with the
  flip-round subtlety, plus r30-3's corrected premise and r30-2's effective-N churn
  cap; §10.2 gains attack vector **P**; §13 gains the taxonomy's fifth axis and
  refreshed Table 2 rows; §11.5 gains the fix-and-re-attack tier; App. A gains
  S-17…S-22, the namespaced finding-code table (r29-*, r30-*, T-1, MC-F7/F8,
  SOAK-F7/F8/F11) and the A.6 note on why rounds 29–31 registered no new PO codes.
- **Counts re-pinned everywhere**: suite **1,656 passed / 1 skipped (74 files)**;
  invariants **158** (INV-ESC-8 was missing from the machine-checkable index and is
  now indexed; `FORMAL_INVARIANTS.md` §14 corrected 157→158 and escalation 7→9);
  cross-check **285 claims / 516 evidence refs / 95.1 %** (271/285); campaign
  **1,187,000 units / 3,745,566 assertions**. `docs/EVALUATION.md` (§2.1, new §2.5,
  §2.4, §3.1, new §4.3, §5, §6, §7), README, `docs/TESTING_GUIDE.md`,
  `docs/CROSS_CHECK.md` §1, `docs/REPRODUCIBILITY.md`, the presentation numbers
  (`OUTLINE`, `DEMO_SCRIPT`) and `docs/proofs/04-machine-safety.tex.md` updated to
  match; no behaviour change.

### Fixed — round-30 transport campaign
- **Provenance overflow bricked the durable inbox** (finding T-1, operational):
  `CourtInbox.ingest` appended one provenance URL per distinct relay without a
  cap, but `CourtInbox.fromSnapshot` rejects any record with more than
  `MAX_RELAYS_PER_RECORD` (64) relays as `corrupt_snapshot`. One wrap delivered
  by 65+ relays therefore produced a snapshot that could never be restored —
  the *whole* inbox (every message) was lost on the next restart, and a hostile
  relay set could trigger it for a legitimate recipient without any key. Ingest
  now caps a record's provenance at the first 64 distinct sources (determinism:
  delivery order), keeps advancing `lastSeen`, and the restored-state check
  stays strict so a tampered store is still rejected. Regression:
  `__tests__/r30InboxOutboxLoad.test.ts` (B).

### Added — round-30 transport + ceremony campaign (test-only, no API change)
- `__tests__/r30SealGames.test.ts` — NIP-59 seal-layer attacks, each pinned to
  the layer that catches it: seal-author mismatch, rumor-id recomputation (and
  the honest boundary that a *consistent* forgery is stopped by the roster
  gate, not the wrap), wrong/compressed recipient p-tag, self-wrapped replay,
  **cross-session seal replay** (the wrap is re-creatable by anyone; the inner
  session binding and freshness are what refuse it), a gift wrap addressed to a
  non-roster peer, and wraps carrying two seals.
- `__tests__/r30MarmotTransport.test.ts` — the MLS surface in two halves: the
  transport *contract* the ceremony needs (epoch-scoped key packages, single-use
  welcomes, authorized member adds), modelled locally because `marmot-ts` is a
  consumer dependency, not this package's; and what the **real** FROST code
  guarantees when the transport lies (non-roster commitments/reveals refused,
  reveals bound to their own nonce, no message transfer between rounds, local
  nonce-reuse refusal).
- `__tests__/r30InboxOutboxLoad.test.ts` — 10k-event flood that is 90%
  duplicates (1,000 records, 10 provenance entries each, bounded serialized
  size, replay-idempotent, restart-stable), provenance cap/overflow,
  `MAX_RECORDS` capacity semantics, and outbox exactly-once under a partial
  relay failure (same stored wrap template rebroadcast, one recipient drain,
  one ack, idempotent ack redelivery) plus canonical-message-key collision
  probes.
- `scripts/court/multi-process-ceremony.mjs` + `scripts/court/juror-child.ts` —
  N = 3…7 **separate OS processes** running the real Pedersen DKG and FROST
  signing round over a loopback HTTP relay that assigns message order;
  `--chaos=kill` (SIGKILL mid-DKG / mid-signing) and `--chaos=replay`
  (cross-round wire replay). The coordinator re-derives the group key from the
  published commitments and verifies the aggregate itself. Gated in CI by
  `__tests__/r30MultiProcessCeremony.test.ts`; scope and honest limits in
  `docs/MULTI_PROCESS_CEREMONY.md`.
- `npm run simulate:multiprocess`.
- Suite: **1,606 passed / 1 skipped, 70 files** (round-30 adds 42 assertions
  across 4 files, including the 4-scenario multi-process gate).

### Fixed — review-round-3 hardening (`docs/REVIEW_ROUND_3.md`)
- **The escalation bond is now bound to the CHALLENGER, not just to the case**
  (r29-1, EXPLOITABLE): `onEscalate` accepted any `bondProofHash` present in
  `state.challenges`, so a juror who posted no bond could escalate by quoting a
  bonded juror's hash — and the append-only audit log named the wrong
  challenger against the wrong bond. The reducer now requires
  `challenge.idx === challengerIdx && challenge.bondProofHash === bondProofHash`
  (`confirmationMachineHandlers.ts`), and the model checker's independent
  property states the same binding (it agreed with the bug). INV-ESC-5.
- **`finalize` re-verifies the escalation witness log** (r29-2, INV-ESC-8): a
  restored `fee_settlement` snapshot could append a fabricated record (a juror
  who never escalated, a round never opened, a bond never posted) and finalize
  on top of it, because the verdict hash deliberately does not cover the log.
  `assertValidEscalationLog` (`confirmationMachineCore.ts`) now enforces
  consecutive `2..k` rounds, the ladder bound, monotone timestamps, the
  challenger-own-bond rule and the frozen `hostEscalation` policy. A short log is
  accepted so pre-0.12 snapshots stay finalizable.
- **The deterministic-budget helper is pinned** (r29-10): a mutant returning
  `Number.POSITIVE_INFINITY` survived all 23 budgeted tests, i.e. a vacuous
  ceiling was invisible to the suite. `__tests__/reviewRound3.test.ts` pins the
  30 s default, the junk fallback and the override.
- Docs: `CHANGELOG` v0.12.0's economic-cap bullet now names `bao.markets` and its
  path — `deriveCourtEconomicCap()` was listed as if it shipped here (r29-9);
  invariants 156 → **157**; suite 1,546 → **1,561** (66 files).

### Added — economic re-verify, round 30 (`docs/proofs/economics/06-expert-verify.tex.md`)

- **`quorumEconomics.ts` (new, additive):** the capture arithmetic of a confirm
  quorum as pure functions of state the machine already records —
  `captureProbability({panelSize, quorum, adversaryWeight})` (exact binomial
  upper tail, BigInt rationals over `ρ_den^N`, Model D of 05 §1.1) and
  `quorumCapCorrection({...})` (κ, the sub-supermajority factor: 4.6364 = 51/11
  at 3-of-5, ρ = ⅓). Exported from the package root next to `confirmSupermajority`.
  **The module header states the contract the cap needs:** κ is *not* a divisor
  for `V_max` — the cap of 05 (5.2) is the π = ½ slice of a family that a weaker
  quorum *tightens* (06 §3, r30-3) — it is the number a host needs for the
  ownership capture table and the P+ε free-attack threshold. No behaviour change;
  13 tests pin every published tail and κ.
- **`docs/proofs/economics/06-expert-verify.tex.md`:** five economic attacks on
  the post-fix layer, each with its model change, EV and verdict — r30-1 (the
  escalation bond is a *membership* test, so the ladder is a free option:
  farming −2.40 %→−1.86 % of $V$ at the shipped cap, venue/griefer 0.86×→54.1×
  at the protocol cap), r30-2 (a frozen 135-seat config churned to 45 seats is
  2.47× short of its own invariant), r30-3 (**SAFE** — the brief's premise is
  false; κ is slack), r30-4 (idle decay replaced the reset cliff with a ramp
  that dominates it at every cycle: +26.0 % at 6/6), r30-5 (**SAFE** on the
  label, grandfathering bounded by r30-2). Registered fixes: per-round bond
  binding (wire, v0.13), anchored decay + penalty ageing (host), cohort check
  (host), inventory sweep (host).
- `scripts/review-quant/economics.mjs` §6 reproduces every number in 06;
  `README`/`00-model`/`02-ladder`/`04-goodhart` carry the corrections at the row
  (spec-pinned price curve, superseded idle-expiry clause), and
  `REVIEW_ROUND_3.md` §9 re-grades r29-3 from LOW to MAJOR (economic).

## [0.12.0] — 2026-11-11

### Changed — review-round-2 hardening (API-visible)
- **`escalate` carries a witness** (`authority`, `challengerIdx`, `challengerPubkey`, `requestHash`, `bondProofHash`, `roundIndex`): the reducer enforces phase, `roundIndex == ladderRound+1`, case-roster challenger, 32-byte-hex hashes, a bond hash the machine already accepted, and host authority only under the frozen `hostEscalation` policy (default false). Accepted witnesses append to a frozen `escalationLog`; `ladder_pending` has exactly two entry transitions — the host-bypass path is closed at the machine, not the API (INV-ESC). `concede` remains host-API-enforced (named residual, SPEC §9.2).
- **Economic security cap derived, γ single-sourced at 0.45** — *host-side, not in
  this package*: `deriveCourtEconomicCap()` lives in `bao.markets`
  (`packages/markets/services/bao-markets/courtEconomicRatio.ts`) and is wired at
  market creation there — `V_max(N) = γ·s₀·N` below the ⌈1/(γσ)⌉ threshold (112
  seats at 0.45), unbounded above; shadow mode `off|shadow|enforce` with
  `would_reject` metrics, boot guard and ECON_RATIO_RUNBOOK (measured rejection:
  testnet 0.5%, demo 4.8%). This package ships no part of it (round-3 finding
  r29-9).
- **Deterministic simulation budget** replaces the 5 s wall-clock gate (`SIM_BUDGET_MS`, default 30 s) — load-insensitive, still catches real regressions.
- **Provenance reconciled**: cross-check parses the PO register (PO-1…18, 283 claims / 512 refs / 95.1 %, 14 open); invariants 149 → **156**; suite **1,546**.

### Tests — round-29 corpora + witness model checking (test-only, no API change)
- **Model checking WITH witness events**: the explorer dispatches an illegal-escalation-witness matrix at every reachable state and fails the instance if any is accepted. Full sweep now **15 instances / 3,869,232 states / 213,521,172 applications**, of which **60,020,684 are witness probes** — `illegalWitnessAccepted = 0` everywhere, `escalationLog` depth ≤ `min(maxLadderRounds, MAX_LADDER_ROUNDS)` (max observed 2), and every terminal phase refuses a perfect witness. Two new instances: `escalate-witness challengers=1,2` (537,825 states) and `r=3 host-escalation` (182,265 states). Finding **F8** (same class as F7): the all-digit witness fixtures made the "uppercase hex" probe a no-op — the new assertion caught it; fixtures now carry hex letters.
- **Three new scale campaigns** (fast subset in CI): `witness` (10,000 escalate-shaped events over a 27-row matrix through the real reducer — 740 accepted / 9,260 typed refusals / 0 raw errors, cross-case bond replays, duplicate rounds, hand-restored cap, oversized values), `epochRotation` (1,000 kind-39018 batches across 40 cohorts / 39 rotations — epoch + cohort pins, re-signing refusals, cross-epoch re-batching, membership proofs) and `finality` (5,000 verdict chains: challenge windows + witnessed escalations → verdict → batch finality shapes, terminal-witness refusals). Campaign total **1,187,000 units / 3,745,566 assertions / 0 failures in 10.1 min**.
- **Not covered here (documented, §3.1 of `docs/benchmarks/SCALE_CAMPAIGN.md`)**: the derived economic cap `deriveCourtEconomicCap()` ships in `bao.markets` (`courtEconomicRatio.ts`, PR #2409), not in `@bao/court`; its boundary corpus is deferred there rather than mirrored here.

## [0.11.0] — 2026-11-11

### Added — external-review response + verification campaign
- Lean 4 mechanisation of single finality (`oracle_single_finality` checked, no sorry; `final_stable`; `machine_alone_insufficient`), toolchain pinned.
- FROST signing attribution (Theorem 6; session journal; `attribution.ts`), RFC 9162 journal spec + D-BATCH signer duty.
- Court judge leaf (`buildCourtJudgeLeaf`) + settlement-binding analysis (A6, INV-SETTLE-1, F-13; honest v1 host-mediated).
- Parameter hardening: `confirmQuorum` default ⌈2N/3⌉; `quorumBelowSupermajority` recorded.
- Proofs: 5 theorems + 4 economic (gap-fills incl. capture table, per-rail V_max, P+ε, seed grinding, splitting) + 4 security definitions + attribution.
- Campaigns: mutation (53 mutants, 8 spec holes closed, 100% re-sweep); scale (1,171,000 units / 3,592,861 checks / 0 failures).
- Paper: related work, assurance-case language, 11 corrections, scope-of-verification, provenance, reviewer disclosure.
- Invariants 145 → 149. Suite 1,534 passed.

## [0.10.2] — 2026-11-10

### Documentation (API-surface documentation round — comments only, zero behavior change)

- **Full public-surface JSDoc pass:** all 489 unique exported symbols
  (212 functions, 27 classes, 132 interfaces, 40 type aliases, 78
  constants across the 32 subpath modules + `index.ts`) now carry JSDoc:
  one-line summary, contract (validation/guarantees), complexity where
  meaningful, failure modes with the error-class/code taxonomy, honest
  limits (caller duties), and cross-references to the INV-* ids in
  docs/FORMAL_INVARIANTS.md.
- **Usage examples** for the core symbols: session identity
  (`assertCourtSessionParameters`, `hashCourtSessionParameters`), ceremony
  machines (`createCourtVoteMachine`, …), selection (`selectJury`),
  signing (`runNormalSigningRound`, `buildAttestationMessage`), validation
  (`validateAttestationEvent`, `validateCourtAttestation`), transport
  (`wrapProtocolEvent`, `unwrapProtocolEvent`), outbox/inbox, escrow
  (`computeRedistributionPlan`, `EscrowLedger`), batch attestation
  (`buildBatchAttestationEvent`, `verifyCaseInBatch`), capabilities
  (`createCourtCapability`, `assertCourtCapabilityAction`), host-key
  backup/recovery, and the appeal coordinator.
- **Module headers** now state each file's pipeline role (ceremony stage),
  purity contract (no I/O, injected clock), and paper section pointer
  (`docs/FROST_COURT_ORACLE_PAPER.md` §).
- **New `docs/GLOSSARY.md`:** 25 precisely defined domain terms (ceremony,
  attestation vs verdict vs confirmation, epoch cohort, batch attestation,
  keeper, fail-closed, purity, …).
- **Stale-reference cleanup:** README install pin 0.6.3 → 0.10.1;
  `SETTLEMENT-RAILS-PLAN.md` → `SETTLEMENT-RAILS.md`;
  `FROST_THRESHOLD_ORACLE_PLAN.md` → `docs/FROST_COURT_ORACLE_PAPER.md`.

## [0.10.1] — 2026-11-10

### Added (round-11 error-taxonomy unification — additive only, no behaviour change)

- **Unified error taxonomy (`errors.ts`):** every error thrown across the
  package boundary is now a `CourtError extends Error` carrying a
  machine-readable `code` (SCREAMING_SNAKE for new codes; the pre-existing
  per-class code unions keep their historical lowercase values) and — when
  the error enforces a documented invariant — an `invariant` field with the
  INV-* id from docs/FORMAL_INVARIANTS.md §15. Cause-chaining is supported
  everywhere via `CourtErrorOptions.cause` → `Error(message, { cause })`.
  Full class/code registry with invariant column: docs/FORMAL_INVARIANTS.md
  §15.
- **15 legacy classes grafted** onto `CourtError` (names, constructors, code
  values, and messages unchanged — `instanceof CourtError` is additionally
  true): `BatchAttestationError`, `CourtVoteTransitionError`,
  `CourtConfirmationTransitionError`, `CourtSigningTransitionError`,
  `CourtDkgTransitionError`, `CourtEpochCohortError`,
  `CourtSignerSetError`, `CourtSessionValidationError`,
  `CourtInboxError`, `CourtHostKeyError`, `CourtKeeperError`,
  `CourtCapabilityError`, `CourtOutboxError`, `CourtProtocolEventError`,
  `CourtRecoveryError`.
- **13 new domain classes** (base-constructor style
  `(code, message, options?)`): `CourtDkgError`, `IndependentDkgError`,
  `IndependentSigningError`, `FrostSigningError`, `CourtSelectionError`,
  `EscrowLedgerError`, `LnHoldLedgerError`, `LnRailError`,
  `LiquidEscrowError`, `TaprootSpendError`, `CourtCryptoError`,
  `CourtSignerError`, `AppealError`; plus the `CourtArgumentError`
  caller-bug base (argument-shape failures carry domain-prefixed codes,
  e.g. `DKG_ARGUMENT`, `TAPROOT_ARGUMENT`).
- **176 plain `throw new Error(...)` sites converted** across 19 modules —
  argument-shape failures to `CourtArgumentError`, protocol/ledger/state
  failures to the domain class. No plain `Error` throw remains in package
  sources (one internal throw-and-catch control-flow site in
  `courtProtocolEvents.ts` `parseContent` is typed too). Messages are
  byte-identical to pre-0.10.1 everywhere.
- **Boundary hardening found by the new suite:** `SeckeyCourtSigner`'s
  constructor decoded malformed hex strings before validation (raw
  decoder `Error` escaped); likewise `taprootSpend.ts` /
  `liquidEscrow.ts` decoded caller hex via the noble decoder before their
  length checks. All three now surface `CourtArgumentError` (with
  `cause` preserved) for malformed-but-typed inputs.
- **`invariant` traceability:** the base field is populated on selected
  enforcing sites (e.g. duplicate batch verdicts → `INV-BATCH-3`,
  selection pool sufficiency → `INV-SEL-6`); the registry table in
  docs/FORMAL_INVARIANTS.md §15.2 maps every class/code family to the
  invariants it enforces.
- **New test suite `__tests__/errorTaxonomy.test.ts` (19 tests):** full
  registry walk (30 classes extend the base, names survive, codes present,
  SCREAMING_SNAKE convention), cause-chaining, invariant field, and the
  boundary law — 15 malformed-but-typed public-API probes assert a typed
  `CourtError`, never a raw `TypeError`/decoder error.
  `invariantAssertions.test.ts` INV-X-2 extended: machine error classes must
  extend `CourtError` and carry a code. **Consumer impact: additive only** —
  existing catch sites (`instanceof`, message, name, legacy `code` values)
  are unaffected.

## [0.10.0] — 2026-11-10

### Added (round-9 performance optimization — no byte output or behaviour changes)

- **`buildBatchMerkleProofs(leaves): BatchMerkleProof[]` (batch-attestation module):**
  full proof-set generation in O(n) node hashes + O(n log n) path slots,
  versus ~O(n²) node hashes for per-leaf `buildBatchMerkleProof` calls
  (each call re-hashes O(n) sibling-subtree nodes; the full set re-hashes
  the same subtrees ~log n times over). The RFC-6962 split recursion visits
  exactly 2n−1 distinct subtrees; hashing the tree once into a node table
  lets every proof read its O(log n) siblings from the table, with path
  entries SHARING the table's string objects (memory: O(n) retained hash
  material, not O(n log n) fresh strings). Output is IDENTICAL — same
  index/verdictHash/path per leaf as the single-proof API — pinned by the
  differential-parity suite (every proof verified under the independent
  reference verifier for n = 1..128, 333, 1000). The single-proof API is
  unchanged. **Consumer impact: additive only** — new export, existing
  exports byte-compatible.
- New benchmarks: `buildBatchMerkleProofs` (full set, n = 10/100/1k/10k) and
  `reduceCourtSigningMachine` (10k legal transitions, roster=threshold=21 —
  the heaviest invariant-checking case), added to `bench/court.bench.mjs`
  and `docs/benchmarks/BASELINE.md`.

### Changed (performance — measured, byte-output-identical)

- **CanonicalWriter — pre-sized growable buffer** replaces the per-field
  chunk array + finish-time concat: one amortized buffer, in-place writes,
  a shared DataView, and a hi/lo split replacing the `BigInt` u64 conversion.
  Byte output identical (differential-parity pinned: byte-identity on 300
  random sequences + boundary + round-trip + fail-closed ranges).
  `canonicalWriter.encodeHash` at 1k field groups: 6.46 ms → 1.48 ms (4.4×;
  5.50 → 1.44 ms on the noise-floor `min`; paired numbers in BASELINE.md).
- **`isValidSecp256k1Point` — bounded validity memo** (cap 8192, clear-on-
  full): point validity is a pure mathematical function of the encoding
  string, so the memo is semantically transparent; it is module-private
  (never enumerable on machine state, never serialized) per the
  verified-verdict cache lesson. This removes the signing machine's dominant
  per-reduce cost — the reducer re-validates EVERY stored nonce commitment
  (2 `Point.fromHex` decodes ≈ 88 µs each on this host class) on EVERY
  transition. `reduceCourtSigningMachine` at roster=threshold=21:
  3340 µs → 110 µs per transition (**30×**; paired numbers in BASELINE.md).
- **Selection hot path** (`selection.ts`): `bytesFromHex` lookup-table decode
  (byte-identical, same accept/reject set); `jurorRandomValue` single
  pre-sized concat instead of two array spreads; `scoreAndSort` ranks light
  `{juror, priority}` records and materializes `SelectedJuror` objects only
  for the selected top-k (previously two full object spreads per juror plus
  idx assignment over the whole pool). Same comparator, same draws, same
  ranking — exact parity verified against the pre-change algorithm across
  randomized rosters, and by the differential-parity end-to-end ranking pin.
  `selectJury` at roster=10k: 88.5 ms → 32.5 ms (**2.7×**; 77.8 → 30.1 ms on
  `min`; paired numbers in BASELINE.md).

### Refused (measured, not worth the risk/complexity — see BASELINE.md round-9 findings)

- **Heap-based O(n log k) top-k jury selection:** 27× on the ranking step
  alone (4.0 ms → 0.148 ms, top-k parity confirmed) but only ~1.12×
  end-to-end at roster=10k — the sha256 draws dominate; below the ≥2× bar.
- **Cross-call CanonicalWriter buffer pooling:** the per-instance pre-sized
  buffer already captures the win; shared mutable scratch state on a
  security-critical encoding primitive for no measured additional benefit.
- **Memoizing `assertSigningRecordInvariants` on state hash:** couples a
  cache to the restored-snapshot corruption class the check exists to catch;
  the point memo captures ~95% of the win. Spec (WeakMap keyed by the frozen
  state object) recorded in BASELINE.md.

## [0.9.4] — 2026-11-10

### Fixed (round-8 adversarial-nostr round — hostile relay data)

- **`appealWatcher` — resolution outcome binding:** `handleEvent` read the
  reported outcome from the single-letter `o` tag BEFORE the validated
  `outcome` tag. The `o` tag is not part of any kind-39007 builder's tag set,
  so a hostile re-publisher of a valid attestation could append an extra
  `['o', <anything>]` tag and steer the reported resolution outcome away from
  the FROST-certified one (the event's own Schnorr signature only proves the
  untrusted publisher signed it). The resolution now carries
  `validation.outcome` — uniqueTag-checked, content-mirrored, and bound into
  the signed attestation message. **Consumer impact: none for honest
  events** (builders never emit `o` on 39007); hostile alias tags can no
  longer steer resolutions.
- **`courtInbox` — dedupe-key integrity:** `ingest` accepted any shape-valid
  64-hex wrap id without verifying the NIP-01 id commitment. A hostile relay
  could serve a same-id different-content wrap that (a) poisoned the stored
  record when it won the delivery race, or (b) deduped the real wrap away on
  redelivery — drain permanently drops junk, so the message was lost either
  way. `ingest` now recomputes the event hash and rejects non-committing ids
  as `malformed`. **Consumer impact: none** — every real wrap id commits by
  construction (`finalizeEvent`); hand-crafted test wraps must derive ids via
  `getEventHash`.
- New adversarial suite `__tests__/adversarialNostr.test.ts`: kind confusion
  (filter drift), tag abuse (duplicates/nesting/empty/100k-mention-tags/
  MB-scale values), NIP-59 seal games (self-wrapped seals, cross-session
  replay, algorithm confusion), inbox flooding (dedupe-key poisoning,
  capacity fail-closed, provenance), watcher outcome binding.



### Fixed (round-7 cryptographic literature audit — docs/CRYPTO_AUDIT.md)

- **`crypto` — DKG proof-of-knowledge challenge encoding (A-2):** the PoK
  challenge was a delimiter-joined string (`prefix|pk|nonce|domain`) whose
  `domain` (`market=…|dispute=…|juror=…`) is attacker-influenced and contains
  the separators — tuples like (market `"x"`, dispute `"y|dispute=z"`) and
  (market `"x|dispute=y"`, dispute `"z"`) rendered identically, aliasing a
  proof across DKG ceremony bindings. The challenge is now CanonicalWriter
  length-prefixed under `bao-frost-court/dkg-pok-challenge-v2`, and the
  domain itself is canonical: new export `dkgPokDomain(marketId, disputeId,
  jurorIdx)` (hex of the length-prefixed tuple), used by both
  `PedersenDkgAdapter.proofDomain` and `IndependentDkgSession`.
  `verifyProofOfKnowledge` accepts v2 (created) and — one documented
  mixed-fleet rollout window — the legacy v1 encoding. **Consumer impact:
  none** within a single-version fleet; mixed-version DKG attempts fail
  closed at the PoK check (attempt restarts, no state corruption).
- **`dispute` — `deriveDisputeGroupPubkey` concat boundary (A-3):** the raw
  `groupPubkey ‖ disputeId` digest input had no fixed-width contract, so
  (pk, disputeId) pairs could alias when a caller passed a short pubkey.
  Creation now enforces exactly-64-char group pubkey and a non-empty ≤512-char
  dispute id; **the digest formula is unchanged** — every previously derived
  key that satisfied the (now explicit) width contract derives identically.
- **`independentSigning` — commitment-set/reveal-set equality guard (A-1):**
  empirically verified for `@vbyte/frost` 1.1.5: FROST Lagrange coefficients
  are indexed by the FULL commitment list, so aggregating threshold reveals
  over a larger commitment set yields a final signature that fails
  `verify_final_sig` (fail-closed liveness trap — every committed-but-silent
  juror burned a nonce commitment per attempt with no diagnostic).
  `canAggregate()` now requires the reveal set to EQUAL the commitment set
  and `aggregate()` throws a precise reason
  (`reveal set must equal the commitment set`). Full-coverage flows are
  unchanged (pinned by new tests, including the fail-early subset case).
  `aggregateAttestation` documents the same contract for direct callers.

### Added

- **`docs/CRYPTO_AUDIT.md`** — the round-7 cryptographic literature audit:
  per-finding literature anchors (FROST/Drijvers, RFC 9591, Crites et al.
  CRYPTO 2025 / ms-FROST 2025, ChillDKG/BIP-445, CVE-2025-58359, RFC 6962),
  code locations, exploitability sketches, and the security-argument
  skeleton (§7) the paper's security chapter builds on. Verdict: keep the
  `@vbyte/frost` 1.1.5 pin, with documented upgrade triggers.
- **Tests:** `__tests__/cryptoLiteratureAudit.test.ts` (9 tests) — PoK
  round-trip/cross-domain/legacy-v1 acceptance, PoK domain tuple
  distinctness, `deriveDisputeGroupPubkey` boundary validation, the
  full-coverage independent signing aggregation, and the library
  binding-factor message-dependence pin (anti-Drijvers property cannot
  silently regress in a dependency upgrade).

## [0.9.2] — 2026-11-10

### Fixed (formal-audit findings F-12, F-2, F-3)

- **`courtSigningMachine` + `courtDkgMachine` — F-12 (state-shape change,
  minor-compat):** both machines now keep the monotonic clock ledger the
  vote/confirmation machines already had: `latestTimestamp` in state, and
  every time-bearing event must satisfy `now ≥ latestTimestamp` (typed
  rejection: `now must not precede a previously observed timestamp`).
  `abort` carries no clock and leaves the ledger unchanged; tick and
  terminal semantics are unchanged (a terminal tick stays phase-preserving
  and may only advance the clock). Old-timestamped replays into a restored
  signing/DKG snapshot are no longer admissible.
  **Restore semantics (additive field):** v0.9.1 snapshots without
  `latestTimestamp` initialize it to `0` on restore — the first
  time-bearing event writes it, and pre-upgrade replay sequences keep
  working (they can only be rejected if they genuinely roll the clock
  backwards). The two idempotent-redelivery paths in the signing machine
  now return the clock-advanced state frozen (freeze discipline preserved).
- **`validator` + `batchAttestation` — F-2:** a present-but-empty
  `expectedGroupPubkey` pin (`''`) is now INVALID — the v1 validator, the
  v2 validator, `validateCourtAttestation`, and
  `validateBatchAttestationEvent` all answer typed-invalid
  (`expectedGroupPubkey pin must be a non-empty group pubkey`) instead of
  silently disabling the pin. A pin must be a real pubkey or absent; the
  absent case behaves exactly as before.
- **`courtConfirmationMachine` — F-3:** the append-only `outcomeHistory` is
  now barrier-verified before it locks value in: a new
  `assertValidOutcomeHistory` runs at `resolve_round` (which steers
  `round_flip` clawbacks from `previous.winnerIndices`) and at `finalize`.
  The barrier enforces the consecutive 1..k round sequence, ballot closure
  of every recorded outcome, unique well-formed `winnerEventIds`, and
  unique valid `winnerIndices` — a hand-restored snapshot with a forged
  history can no longer direct clawbacks at arbitrary indices.

### Added

- **Exports:** `weightedPriority` is now exported from the package root
  (it was reachable only via the `./selection` subpath — the juror-kit
  weight-mode verification needs it from the vendored-visible surface).
  `IndependentDkgSession` / `IndependentSigningSession` and their state
  types (`IndependentDkgState`, `IndependentSigningState`,
  `IndependentSigningSnapshot`) were verified present on the root surface.

## [0.9.1] — 2026-11-09

### Fixed (round-3 property-sweep findings)
- **`courtConfirmationMachine` — r3-1:** `finalize` over a restored EMPTY
  confirmation ledger used to escape the vote machine's FOREIGN
  `CourtVoteTransitionError` (empty `supportingEventIds` reached
  `hashCourtVerdict`). Finalize now fails closed with the machine's own
  typed `CourtConfirmationTransitionError` when the verdict would carry zero
  supporting event ids. Unreachable on live paths — `close_confirmations`
  enforces the quorum (unchallenged cases) and `resolve_round` refuses an
  empty vote ledger (challenged cases) — the guard protects the
  restore/replay path.
- **`batchAttestation` — r3-2:** `verifyCaseInBatch` escaped a raw
  `TypeError` for a tags-less event once the proof leaf matched. The event
  shape (`tags` array) is now validated BEFORE leaf work, answering the
  module's typed `{ valid: false, reason: 'malformed event' }` — identical
  to `validateBatchAttestationEvent`'s guard. Malformed call arguments
  (proof path/index) still throw the typed `BatchAttestationError` as before.
- **`validator` — r3-3:** `validateCourtAttestation` dereferenced
  `event.tags` unguarded in the v1/v2 shape dispatch, crashing with a raw
  `TypeError` on malformed events. Now guarded: a tags-less event answers
  the typed `{ valid: false, error: 'Malformed event: tags must be an
  array' }`.
- **`courtConfirmationMachine` — r3-6 (design bug):** a challenged case on a
  2-member case roster could NEVER resolve: the ladder round panel defaults
  to the case roster, but the close/resolve ledger barrier demands ≥ 3
  round-panel members — a mid-ladder dead end. Chosen fix: **fail closed at
  creation** — `createCourtConfirmationMachine` now rejects a
  `participantIndices` roster with fewer than 3 members (typed
  `CourtConfirmationTransitionError`, `confirmation roster must contain at
  least 3 participants`). This is the cleanest consistent rule: the
  confirmation-quorum and round-panel semantics presuppose a panel. One
  pre-existing test (`adversarialMachines.test.ts` quorum-shortfall case)
  was updated from a 2-member to a 3-member roster; no API consumer change
  beyond the stricter creation guard.
- **`validator` — r3-5:** `hashSignerSetRoot` threw a plain `Error`; it now
  throws the new typed **`CourtSignerSetError`** (exported from the package
  root; error messages byte-identical to the previous text).
- **`validator` — r3-4 (observation, documentation only):** documented the
  nostr-tools `verifyEvent` verdict-cache semantics on
  `validateAttestationEvent` (cache lives under a Symbol-keyed property,
  derived state only; object-spread clones never carry it and re-verify
  from scratch — in-place mutation of a verified event is the residual
  hazard). No behaviour change.

## [0.9.0] — 2026-11-09

### Added (multi-round ladder escalation, universal-confirmation proposal §4.2)
- **`courtConfirmationMachine` ladder is now multi-round.** Round panels grow
  host-side (reference sizes r1=15, r2=45, r3=135 — FROST-subset selection is
  host policy; the machine tracks rounds + votes). `createCourtConfirmationMachine`
  gains `maxLadderRounds` (default 2, bounded 1..5).
- **New phase `round_resolved`** — after a round resolves with rounds
  remaining, the case parks there for an explicit host decision: new events
  `escalate` (→ `ladder_pending`, next round) or `concede` (→
  `fee_settlement`, current outcome final). The machine never auto-escalates.
  Resolving round `maxLadderRounds` proceeds to `fee_settlement` directly.
- **Per-round roster expansion** — `open_ladder_round` accepts an optional
  `roundRoster` (sequential indices 1..N, N ≥ 3, N ≤ 10 000; superset of the
  previous round NOT required). Mass votes validate against the ROUND panel;
  round rosters re-verify at the close/resolve ledger barrier.
- **Flip-flop clawback rule** — when round r's winner differs from round
  r-1's winner, round r-1's majority voters are flagged with reason
  `round_flip` (round = r-1). Flag accounting stays append-only and
  idempotent: `overturned_confirmation` flags fire once (no duplicates on
  repeated overturns), `round_flip` dedupes per (idx, reason, round).
- **`outcomeHistory`** — append-only frozen `{round, outcome,
  winnerEventIds, winnerIndices}[]` for host-side reputation scoring
  (final-round weight 1.0, earlier 0.5 — scoring is host policy). Finality:
  the verdict is the LAST resolved round's winner, backed by that round's
  winning-vote event ids (confirmation ids when never challenged).
- **Compatibility:** the v0.8.5 single-round flow is preserved via
  `maxLadderRounds: 1` (resolve → `fee_settlement` directly) and produces
  verdict-identical results to the default-cap flow with an explicit
  `concede`. Consumers driving the default cap must now play
  `concede`/`escalate` after each non-final round resolution.
- Suite: 1314 passed / 1 skipped (adds `__tests__/multiRoundLadder.test.ts`).

## [0.8.5] — 2026-11-09

### Fixed (round-2 cross-module adversarial audit, PR #41)
- **`AttestationV2ValidationContext` gained `expectedBatchMerkleRoot`** — the
  v2 `batch` tag carried only the Merkle root with no way to pin it; a stale
  epoch's batch attestation could satisfy epoch policy via the epoch pin
  alone. Now pinnable fail-closed (and in `V2_ONLY_POLICY_FIELDS`, refused on
  v1-shaped downgrades).
- **Confirmation/challenge ledgers re-verified after snapshot restore** —
  `assertValidConfirmationLedger` (canonical confirmHash recomputation,
  roster/hex/uniqueness) runs at `resolve_round` + `finalize`; a restored
  snapshot could previously carry edited confirmations into finalization.
- **Docstring hardening:** loud MUST-pin-`expectedGroupPubkey` warnings on
  `validateAttestationEventV2` / `validateCourtAttestation` / batch context —
  unpinned consumers accept any valid signature (documented trust boundary).
- Documented by-design: same `verdictHash` in two epoch batches is valid —
  reputation derivation MUST dedupe by verdict hash; cross-round vote leakage
  impossible (barrier).
- Suite: 1259 passed / 1 skipped.

## [0.8.4] — 2026-11-09

### Fixed
- **Consumer-typelib compat:** `Object.hasOwn` (ES2022) in the adversarial
  suite breaks typecheck under consumers whose `lib` target predates
  es2022 (bao.markets build-config typecheck) — replaced with
  `Object.prototype.hasOwnProperty.call`. Source-distributed packages must
  stay within the consumer lib baseline.

## [0.8.3] — 2026-11-09

### Fixed (round-1 adversarial machine fuzz, PR #37)
- **Canonicalization bypass:** lone surrogates encoded identically to their
  U+FFFD replacement — two distinct outcomes hashed identically while the
  tally counted separate buckets (order-dependent majorities). All four
  machines now reject non-canonical UTF-8 (`isCanonicalUtf8Text` round-trip
  check) at creation and in every hash helper; the dead surrogate-only fatal
  decoder is replaced by the round-trip gate.
- **State-shape tampering:** null/string rosters crashed uncaught; string
  allowlists admitted substring outcomes past the ledger barrier
  (`'YES'.includes('Y')`). `assertStateArrays` + roster array guard at every
  reducer entry.
- **Signing binding re-verification:** restored snapshots could edit
  outcome/threshold/roster post-hoc (below-threshold aggregates) — the
  signing-session hash is now re-derived on every dispatch.
- **Freeze discipline:** signing/DKG machines now freeze returned states
  (uniform with vote/confirmation).
- **Unknown event types:** reducers throw typed errors instead of returning
  unfrozen clock-advanced copies.
- Reported-not-fixed (owner decisions): cross-index eventId reuse wedges
  resolution fail-closed until tick-expiry; `abort.reason` unbounded.
- Suite: 1206 passed / 1 skipped (+404 adversarial tests).

## [0.8.2] — 2026-11-09

### Fixed
- **Security round 1 (validator/finality adversarial audit).** Three real
  findings, all fixed in v2 paths + the dispatcher only; the frozen v1
  validator is byte-compatible for legacy events (validated by
  `__tests__/validator.test.ts`).
  - **F3 (high) — v2 scope pins silently dropped.**
    `validateAttestationEventV2` declared `expectedMarketId`,
    `expectedDisputeEventId`, and `allowedOutcomes` on its context but never
    enforced them: an attestation for the wrong market, a foreign dispute,
    or a non-allowed outcome validated under v2. All three are now enforced
    exactly as in the frozen v1 path.
  - **F1 (medium) — dispatcher policy downgrade.**
    `validateCourtAttestation` routed a v1-shaped event (no `epoch` tag) to
    the frozen v1 validator while silently IGNORING v2-only finality policy
    (`expectedEpoch` / `minTier` / `minThreshold` / `expectedSignerSetRoot`
    / `signerSet`) — a stale v1 attestation could satisfy policy it never
    met. The dispatcher now fails closed when v2 policy is requested for a
    v1-shaped event.
  - **F2 (low) — unbounded v2 field lengths.** v2 validators now bound
    `marketId` (1024 UTF-8 bytes), `outcome` (256, mirrors the vote
    machine's `MAX_OUTCOME_BYTES`), and `round` (64) before hashing, so a
    hostile relay cannot force megabyte-scale hash inputs. v1 keeps its
    frozen unbounded behaviour (documented).
- Verified-hard (no change needed): epoch-tag downgrade of a v2 event to the
  v1 validator is structurally impossible (v1 recomputes a different domain
  digest); noble `schnorr.verify` rejects malleable `s ≥ n`, `s = 0`, and
  non-curve pubkeys; `hashSignerSetRoot` rejects unsorted-free duplicates,
  non-positive, fractional, NaN, and >2³² indices (no truncation collisions —
  `CanonicalWriter.u32` throws); the vote-machine tie-break uses
  `compareOutcomeUtf8` (UTF-8 byte order) where JS UTF-16 order diverges;
  NFC/NFD outcomes are distinct with no aliasing. Repro suite:
  `__tests__/attestationValidator.adversarial.test.ts` (30 cases).

## [0.8.1] — 2026-11-09

### Added
- **v2 attestation validation with in-band finality binding
  (`validator.ts`).** `hashSignerSetRoot` (canonical sorted-index commitment
  under `BAO-Court/SignerSet/v1`), `validateAttestationEventV2` (requires
  epoch/tier/threshold/signers tags mirrored in content; recomputes the v2
  signed message via `buildAttestationMessageV2`; dispute attestations
  recompute the verdict hash exactly as the frozen v1 path; finality-policy
  pins: expected epoch, minimum tier/threshold, signer-set root, full
  signer-set verification with `length === threshold`), and
  `validateCourtAttestation` (dispatcher: `epoch` tag → v2, else frozen v1).
  Closes the round-0-attestation-replayed-as-final gap end to end.

## [0.8.0] — 2026-11-08

### Added
- **Universal confirmation case machine (`courtConfirmationMachine.ts`).**
  Pure fail-closed reducer for the confirm/challenge lifecycle: public
  juror confirmations (`hashCourtConfirmation` binds session + proposal +
  roster index), a bond-witnessed challenge window, one mass-vote ladder
  round resolved by majority (vote-machine tie-break semantics), automatic
  `overturned_confirmation` clawback flags when a proposal is overturned,
  a fee ledger, explicit clawback flags during fee settlement, and a final
  verdict whose hash reuses `hashCourtVerdict` so kind-89 attestations can
  reference it unchanged. Multi-round escalation is future work (documented
  in-module).
- **Merkle-batched attestations (`batchAttestation.ts`, kind 39018).**
  RFC-6962-style domain-separated tree over `hashCourtVerdict` leaves
  (`BAO-Court/BatchLeaf/v1` / `BatchNode/v1`), sorted-leaf determinism with
  duplicate rejection, unbalanced-split shape stability, inclusion proofs,
  `hashBatchManifest` under `BAO-Court/BatchManifest/v1`, event builder +
  fail-closed validator + per-case `verifyCaseInBatch` — one threshold
  signature now covers a whole epoch batch of verdicts.
- **Zero-stake reputation-weighted selection (`selection.ts`).** Optional
  `weightFn` (pure, deterministic, fail-closed validation) and
  `zeroStakeAllowed` gate-waiver; default draw path byte-identical;
  `verifyJurySelection` round-trips both modes. Phase-0 vetted juror pools
  no longer require stake.

## [0.7.2] — 2026-09-30

### Fixed
- **Liquid CLTV refunds pay the funder, with minimal tapscript locktimes.**
  `buildTaprootLeaves` takes a required `funderXOnly` and the refund leaf is
  `<locktime> OP_CLTV OP_DROP <funder> OP_CHECKSIG` — the depositor's key,
  never the oracle's (previously the oracle could reclaim a refunded bond).
  `locktimeToPush` now emits the MINIMAL signed script-number push required
  by BIP-342 (trailing 0x00 bytes are rejected; a high-bit 4-byte value gets
  the positive 5-byte form), so OP_CLTV accepts the argument at spend time.
  Taproot vectors regenerated (leaf lengths, merkle roots, output keys,
  addresses, control-block parity).
- **LN hold settlement binds every hold to its plan.** `planDecisionsForHolds`
  rejects (throws) a hold whose payment hash does not match its own witness or
  whose amount does not match the plan stake, leaves holds from another
  dispute/round unsettled, and matches bond holds by `plan.disputerPubkey` —
  a foreign "disputer" hold can no longer inherit this plan's bond outcome.
- **Bond admission verifies ownership against the court-derived script.**
  `bondScriptXOnlyPubkey` / `verifyBondOwnershipForScript` bind a candidacy's
  signed challenge (txid/vout/dispute/candidate + nonce) to the P2PK/P2TR
  bond script. The coordinator requires `expectedStakeScriptPubKey` whenever a
  bond verifier is wired, enforces `requireBondOwnership` (default true), one
  locked UTXO per candidacy per dispute, and takes selection weight from the
  VERIFIED stake amount. `verifyBond` fails closed when given an
  `expectedAddress` without a derived `expectedScriptPubKey`.
- **Candidacies carry an optional bond-ownership proof.** Kind 39001 parsing
  reads `ownershipNonce` / `ownershipSig` tags into
  `StakeCommitment.ownershipProof` (`BondOwnershipProof`).

### Breaking
- `TaprootEscrowParams` gains required `funderXOnly`.
- `FrostAppealCoordinatorConfig` gains `expectedStakeScriptPubKey` and
  `requireBondOwnership`. With a `bondVerifier` wired, admission now also
  requires the court-derived script and (by default) an ownership proof; the
  weight used for selection comes from the verified UTXO amount.
- `FrostAppealCoordinatorConfig.verifyStakeCommitment` stays a boolean hook.

## [0.7.1] — 2026-09-26

### Fixed
- **DKG shares are bound to the NIP-59 envelope author.**
  `parseEncryptedShareEvent` / `parseEncryptedRefreshShareEvent` now take the
  sender from the signed envelope author (`event.pubkey`) and reject events
  with no author or with a `from` tag/content pubkey that disagrees with it —
  a forged share claiming an honest juror's roster pubkey is no longer
  re-attributed to that juror (it is rejected). `IndependentDkgSession`
  `addEncryptedShare` / `addEncryptedRefreshShare` take the envelope author as
  an optional second argument and require `payload.fromPubkey` (and the
  author, when provided) to equal the roster pubkey for `fromIdx`.
- **The appeal coordinator tallies only signed commit/reveal events.**
  `vote_commit` collects signature-verified Kind 39004 commits authored by a
  selected juror for this dispute (conflicting commits from one juror →
  reselection), and `vote_reveal` counts only signature-verified Kind 39014
  reveals whose `hashCommit(outcome, salt)` matches that juror's signed
  commit. The verdict is never fabricated from the challenger's
  `proposedOutcome`; a tally with no valid reveal triggers reselection instead
  of attesting an empty outcome. The former self-contained flow stays behind
  the explicit, test-only `simulateVotes` config switch (defaults to
  `environment === 'test'`); `vote_commits_collected` / `vote_reveals_collected`
  payloads carry `simulated`.
- **Appeal settlement requires a pinned group key.** `settleAppeal` fails
  closed (`unpinned_group_key`) for an attestation under a group key that is
  neither the appeal's local `dkgRecord.groupPubkeyXOnly` nor an explicitly
  allow-listed `empaneledGroupKeys` entry — an injected appeal can no longer
  settle under a self-chosen key.

### Breaking
- `FrostAppealCoordinatorConfig` gains `simulateVotes` and
  `empaneledGroupKeys` (both optional, no signature changes). Behaviour
  changes by design: outside `environment: 'test'` the coordinator now
  collects signed Kind 39004/39014 events instead of fabricating votes from
  the challenger's claim, and externally-attested appeals with no local DKG
  record must list the empaneled group key(s). Test-environment hosts keep
  the simulated flow unless they pass `simulateVotes: false`.

## [0.7.0] — 2026-08-27

### Added
- **M3 pairwise dual-refund WS-A tree leaves** (SMJ-MATCHING-ENGINE-PLAN.md
  §M3, user-vs-user matched pairs):
  - `buildPairwiseCoopLeaf(pkA, pkB)` — strict **2-of-2** coop leaf
    `<pkA> OP_CHECKSIG <pkB> OP_CHECKSIGADD OP_2 OP_EQUAL` (`20<pkA>ac20<pkB>ba5287`).
    Deliberately stricter than the WS-E `buildCoopStakeLeaf` shape (`… ba`,
    which tapscript evaluates as 1-of-2 — acceptable there because the server
    enforces the sponsor signature, but a theft vector user-vs-user where the
    refusing loser could claim both UTXOs). Witness order `[sigB, sigA, leaf,
    control]` matches WS-E's `[operatorSig, sponsorSig, …]` assembly.
  - `buildDualRefundLeaves(pkA, pkB, refundLocktime)` — `[REFUND-A, REFUND-B]`
    mirroring `buildWsARefundLeaf` per participant, so each user can pull back
    only their OWN side after close+Δ.
  - Frozen 3-leaf vectors (§8.1 style): leaf scripts, tapleaf hashes, split-
    at-half merkle root, output key / signet address, and all three control
    blocks, plus a minimal tapscript interpreter test proving the strict
    2-of-2 semantics (both sigs required; one sig fails; the WS-E 1-of-2
    shape demonstrably passes with one).

### Fixed
- **`taprootMerklePath` emitted siblings in root→leaf order (latent
  consensus bug for >2-leaf trees).** BIP-341 folds a control-block path in
  leaf→root order; the implementation accumulated top-down, so any leaf whose
  path had ≥2 siblings produced a control block that did not re-derive
  `tapMerkleRoot` (consensus-invalid). Every shipped consumer — WS-A and WS-E
  two-leaf trees and the live spend proof — was order-invariant and therefore
  unaffected; the bug was found while drafting the 3-leaf pairwise tree and
  is regression-guarded by the fold-back assertions in the new vectors.

## [0.6.3] — 2026-08-25

**⚠️ ALL TREE/TWEAK-DERIVED VALUES CHANGE vs ≤ 0.6.2 — READ BEFORE UPGRADING.**
Elements consensus tags the taproot hashes `TapLeaf/elements`,
`TapBranch/elements`, and `TapTweak/elements` (Elements
`src/script/interpreter.cpp` HASHER_TAPLEAF/TAPBRANCH_ELEMENTS,
`src/pubkeys.cpp` HASHER_TAPTWEAK_ELEMENTS). v0.6.2 (and earlier) used
Bitcoin's plain BIP-341 tags: every merkle root, tapleaf hash, output key /
taproot program, taproot address, output-key parity bit, and control block
derived by those versions is **invalid on any Elements chain** — script-path spends fail with `mempool-script-verify-flag-failed (Witness program hash
mismatch)`. No production consumers exist yet (verified 2026-08-25), so the
correction is a patch bump; API shape is unchanged.

### Fixed
- **Tagged-hash domains + Tapscript leaf version (consensus blockers).**
  `liquidEscrow.ts` (`tapMerkleRoot`, `taprootProgram`) and `taprootSpend.ts`
  (`tapleafHash`, `branchHash`, `outputKeyParity`, `TAPROOT_LEAF_VERSION`,
  `TAPROOT_CONTROL_BASE`) now derive under the `/elements` tags AND the
  Elements Tapscript leaf version **0xc4** (Elements interpreter.h
  TAPROOT_LEAF_TAPSCRIPT — Bitcoin's BIP-342 value is 0xc0, which elementsd
  rejects with "Taproot version reserved for soft-fork upgrades"). The two
  bugs surfaced as distinct consensus rejections during live testing: wrong
  tags → "Witness program hash mismatch"; right tags + 0xc0 → upgradable-
  version rejection. The sighash tag (`TapSighash/elements`) was already
  correct in v0.6.x (its known-answer test digest moved only because the
  tapleaf hash inside the preimage changed). Proven against Elements Core sources
  and a live elementsregtest chain: a hand-built WS-A cooperative script-path
  spend (funded from the faucet, broadcast via `sendrawtransaction`) is
  accepted by consensus and confirms on-chain only with these tags — the new
  live test `__tests__/taprootSpend-live.test.ts` encodes that end-to-end §8.6
  proof (env-gated: `BAO_LIVE_TAPROOT=true` + esplora + ssh targets).
- **Live test actually exercises consensus.** The previous live test "spent"
  via a second wallet send; the witness never touched validation. It now:
  derives a fresh trader keypair, builds the production two-leaf tree, funds
  the NUMS-taproot address, locates the UTXO by scriptPubKey, hand-serializes
  the Elements transaction (single flags byte, witness-at-end layout, explicit
  asset/value commitments with WIRE byte order — asset ids are reversed
  uint256s like txids — explicit policy-asset fee output last), signs the COOP
  leaf under SIGHASH_DEFAULT, broadcasts, mines, and verifies the confirmed
  spend consumed our UTXO with our exact witness stack.

### Changed
- Regenerated pinned vectors under the corrected domains (§8.1 roots/keys/
  addresses/control blocks, BIP-341 official-vector inputs, 3-leaf tree-shape
  root); added a literal-tag regression guard suite ("Elements tagged-hash
  domains") plus independent numeric parity cross-checks. Bitcoin-domain
  originals are preserved as comments for provenance.

## [0.6.2] — 2026-08-24

Consensus-correctness release for `./taproot-spend`: three independent
BIP-341/Elements bugs fixed. **Consumer-visible signature changes** in
`controlBlock` / `scriptPathControlBlock` — see *Changed* below.

### Fixed
- **Control-block parity (consensus blocker).** The script-path control
  block's low bit is the Y-parity of the OUTPUT key
  Q = lift_x(P) + tagged_hash("TapTweak", P ‖ root)·G per BIP-341 — not a
  property of the internal key. v0.6.0 defaulted it to 0, producing
  consensus-invalid control blocks for every output whose Q has odd Y (~50%:
  proven numerically on the §8.1 vectors). Parity is now derived from
  `(internalKey, merkleRoot)` via the new `outputKeyParity` export and cannot
  be mis-stated; `finalizeTaproot` now rejects control blocks whose parity
  bit contradicts the recomputed output key (the old x-only output-key check
  could not catch this).
- **Genesis byte order in the Elements sighash.**
  `LIQUID_MAINNET_GENESIS` / `LIQUID_TESTNET_GENESIS` are documented as
  uint256 INTERNAL byte order (Elements Core seeds
  `HASHER_TAPSIGHASH_ELEMENTS` with the raw genesis uint256 twice), but the
  values shipped were the well-known DISPLAY hex — every sighash preimage got
  reversed bytes. The constants now hold true internal order, derived from
  their display forms (`reverseHex`) so the two orders cannot be mixed up
  again. Verified against Elements Core `src/script/interpreter.cpp`,
  `src/uint256.h` serialization, the `kernel/chainparams.cpp` mainnet genesis
  assert, and the live Liquid / liquidtestnet Esplora APIs (height 0).
- **`finalizeTaproot` hash_type witness form.** A non-default `hashType`
  silently produced a bare 64-byte signature element; BIP-341/Elements
  require the hash_type byte appended (65-byte element,
  `CheckSchnorrSignature`). SIGHASH_DEFAULT keeps the 64-byte form.

### Changed (consumer-visible)
- `controlBlock(internalKeyXOnly, merklePath)` →
  `controlBlock(internalKeyXOnly, merklePath, merkleRoot)`: the third
  parameter is now the merkle ROOT the parity is derived from (was a manual
  `parity: 0|1` defaulting to 0 — the bug above).
- `scriptPathControlBlock(internalKeyXOnly, leaves, leafIndex, parity?)` →
  `scriptPathControlBlock(internalKeyXOnly, leaves, leafIndex)`: path, root
  and parity are all derived internally.
- New export `outputKeyParity(internalKeyXOnly, merkleRoot): 0 | 1`.
- **Live test infra is now env-injected (CI-safe, no IPs in code).**
  `__tests__/taprootSpend-live.test.ts` is skipped unless
  `BAO_LIVE_TAPROOT=true` with `BAO_ELEMENTS_ESPLORA` + `BAO_ELEMENTS_SSH`
  set (`npm run test:live`). GitHub CI no longer needs VPS SSH access.

### Vector regeneration (spec §8.1, v2.2)
- `CB_T0` / `CB_T1` re-pinned with prefix `0xc1` (Q_T has odd Y); paths and
  all other §8.1 values unchanged (`CB_C0` / `CB_C1` stay `0xc0` — Q_C is
  even-Y, which is why they passed before). Tests add an independent numeric
  Q-parity cross-check, a genesis-byte-order pin against the display hashes,
  a non-default-hashType witness test, and a finalizeTaproot parity-rejection
  test; the hand-built sighash known-answer digest was re-pinned for the
  corrected genesis bytes.

## [0.6.0] — 2026-08-24

New module — WS-A Taproot script-path spend finalization for Liquid/Elements
(`./taproot-spend`). Pure math, no new runtime deps, consumer-visible surface
additive only (one new export in `liquidEscrow.ts`).

### Added
- `taprootSpend.ts` — `controlBlock` / `scriptPathControlBlock` (BIP-341
  control-block construction over the same split-at-half tree
  `tapMerkleRoot` commits), `taprootMerklePath`, `merkleRootFromLeafAndPath`,
  `tapleafHash`, and the WS-A leaf builders `buildWsACoopLeaf` /
  `buildWsARefundLeaf` (owner-key-only leaves, D1-no).
- `taprootSighashElements` — faithful port of Elements Core
  `SignatureHashSchnorr` (TAPSCRIPT): tag `"TapSighash/elements"` with the
  chain-genesis prefix, outpoint flags, confidential asset/value/nonce
  serializations, issuance + issuance-rangeproof commitments, output-witness
  (rangeproof/surjection) commitments; SIGHASH_DEFAULT/ALL/NONE/SINGLE + ACP
  branches; no annex support (WS-A leaves never use one).
- `finalizeTaproot` — computes the sighash and assembles the
  `[sig, ...stack, leafScript, controlBlock]` witness, with optional
  leaf+control-block→output-key verification.
- `serializeExplicitValue` / `serializeExplicitAsset` / `reverseHex`
  (Elements confidential-field wire forms) and network genesis constants
  `LIQUID_MAINNET_GENESIS` / `LIQUID_TESTNET_GENESIS`.
- `liquidEscrow.ts` now exports `locktimeToPush` (was module-private).
- `__tests__/taprootSpend.test.ts` — the WS-A spec §8.1 frozen vectors
  (leaves, merkle roots, output keys, signet addresses, control blocks), an
  independently hand-built sighash known-answer, determinism/sensitivity
  checks, `finalizeTaproot` verification, and the D1-no property test.

### Vector correction (spec §8.1, v2.1)
- The frozen v2 REFUND-leaf hex emitted `b1 00` where spec §3 defines
  `<locktime> OP_CLTV OP_DROP <pk> OP_CHECKSIG` — `0x00` in place of
  `OP_DROP` (`0x75`), a bug in the deleted vector generator. The corrected
  leaves regenerate MERKLE/Q/ADDR and the COOP-leaf control blocks; COOP
  leaves and REFUND-leaf control-block paths are unchanged. See the spec's
  correction note.

## [0.5.5] — 2026-08-23

Test-hardening and developer-docs pass. No protocol or wire-format changes —
nothing consumer-visible beyond docs.

### Changed
- Appeal coordinator/watcher tests drive the genuine fetch → detect → emit
  pipeline through host-injected relay fakes instead of manual state injection,
  and pin relay-filter shape, subscription cleanup, and the jury-selection seed.
- Adversarial fuzz assertions rewritten from false-positive-prone try/catch
  sentinels to typed `.toThrow(CourtProtocolEventError)` checks.

### Added
- `FrostWatcherRelayPool` — narrow structural type for
  `FrostAppealWatcherConfig.pool` (nostr-tools' `SimplePool` still satisfies it;
  hosts and tests no longer need casts against the full SimplePool surface).
- Decrypt-guard invocation counting in inbox tests; bond-pubkey derivation pin.
- `npm run typecheck:tests` — `__tests__/` is now typechecked (CI included);
  it was previously excluded from every gate.

### Fixed
- `FrostAppealWatcher.handleEvent` dedup race: concurrent duplicate deliveries
  racing through the async group-pubkey resolver could both pass the
  processed-event check and double-fire `onResolution`. Ids are now reserved
  synchronously on entry (failed validations remain retryable as before).

## [0.5.4] — 2026-08-21

Developer-experience release (live DX audit of v0.5.3). No protocol or
wire-format changes — patch bump only.

### Added
- `CHANGELOG.md` (this file), backfilled v0.2.0 → v0.5.3 with migration
  notes lifted from the FIXES memos.
- CI workflow (`.github/workflows/ci.yml`) running the full AGENTS.md
  verification battery (typecheck, typecheck:scripts, tests, court
  simulation) on push to `main` and on PRs.
- GitHub issue templates: bug report (with fail-closed/protocol impact
  triage) and feature request (with compatibility + security notes).
- Runnable Quick start ceremony example in the README (verified to produce
  the documented output).

### Changed
- README: consumption instructions now state plainly that `@bao/court` is a
  raw-TypeScript source package requiring a TS-aware resolver (tsx / Vite /
  bundler) — plain `node` cannot resolve the extensionless internal imports.
  Subpath imports (`@bao/court/events`, etc.) documented.
- `CONTRIBUTING.md`: contributors must keep `CHANGELOG.md` current.

## [0.5.3] — 2026-08-21

V12 audit hardening (all 35 actionable findings implemented) + architecture
deepening. See `docs/FIXES-2026-08-21.md` for the full memo.

### Added
- Ceremony machine caps and coercion guards: roster caps (10 000), outcome
  caps, bounded partial-signature / unwrap-batch sizes, strict UTF-8 and hex
  shape validation on every admission boundary.
- Verdict-ledger integrity barriers (`assertValidRevealLedger`,
  `assertSigningRecordInvariants`) run before `close_reveals` /
  `finalize_tally` so tampered ledgers fail before the verdict is locked.
- Duplicate-juror-pubkey rejection in DKG keygen; parameter bounds validated
  before cryptographic processing.
- Verdict-certified attestation enforcement at validation/settlement
  boundaries: `verdictHash` is recomputed from the supporting event ids and
  checked before a settlement is accepted.

### Changed
- External NIP-59 gift wraps are re-verified before routing; transient unwrap
  failures are retried on the next drain instead of being dropped.
- Evidence hashes on dispute events are canonicalized (lowercased + sorted)
  so the event is insertion-order-independent.
- Vote-commit format discriminator: session-bound commits set a version bit,
  legacy sessionless commits clear it, and the vote reducer rejects legacy
  commits at admission (they could never match a reveal).

### Architecture (public API unchanged)
- `courtCeremonyCore.ts` — roster/deadline/phase/blame/caps shared by the
  DKG, vote, and signing machines (was duplicated in parallel).
- `courtUnwrapCore.ts` — one filter/dedup/bounds core behind the seckey and
  signer unwrap adapters.
- `courtEventParseCore.ts` — tag/content/value primitives shared by the
  lenient (`events.ts`) and strict (`courtProtocolEvents.ts`) parse tiers.
- `docs/adr/0001` parks the appealCoordinator-as-machine conversion;
  `CONTEXT.md` adds a domain glossary.

### Fixed
- `blamedIdx` must now be a positive roster integer (no forged peer-blame).
- Duplicate partial signatures rejected (could bypass the distinct-signer
  threshold check).
- `deadline` tamper-detection on `tick` for signing state restored from a
  corrupted snapshot.
- Unwrap batch/kind-filter bounds before processing.

## [0.5.2] — 2026-08-18

Docs/version-header sync only — no code changes.

## [0.5.1] — 2026-08-18

### Fixed
- Regression tests type-clean under consumer tsconfigs.

## [0.5.0] — 2026-08-18

2026-08-18 adversarial deep review (rounds 1–7). **Wire-format breaking
changes** — see `docs/FIXES-2026-08-18.md` for the full analysis.

### Breaking
- **Canonical length-prefixed hashing.** `buildAttestationMessage`,
  `createBondOwnershipChallenge`, and `deriveLnPreimage` no longer join
  fields with `|`; they hash `CanonicalWriter` length-prefixed fields under
  explicit domain tags (`BAO-Court/AttestationMessage/v1`,
  `BAO-Court/BondOwnership/v1`, `BAO-Court/LnPreimage/v1`). Signatures keep
  their shapes but produce **new digests** — old attestation messages, bond
  challenges, and invoice preimages no longer verify.
- **Verdict-certified attestations.** Dispute attestations (kind 39007)
  must carry a `verdict_hash` over the session, outcome, and supporting
  reveal event ids; `validateAttestationEvent` rejects attestations without
  it. Consumers publishing dispute overrides must include the verdict hash.
- **BIP-341 compliance** for Liquid Taproot escrow script trees.

### Changed
- Commit/reveal vote commitments use the session-bound canonical encoding
  (length-prefixed `sessionHash || outcome || salt` under
  `BAO-Court/VoteCommit/v1`).

## [0.4.0] — 2026-08-17

### Added
- JIT appeal pipeline ported from bao.markets: `appealCoordinator.ts`
  (event-driven dispute → candidacy → selection → DKG → vote → signing →
  attestation), `appealWatcher.ts`, `appealTiming.ts`.
- Protocol paper: `docs/FROST_COURT_ORACLE_PAPER.md`.

## [0.3.0] — 2026-08-16

### Added
- Settlement rails (protocol-side only):
  - **Panel A — Lightning hold invoices** (`lnSettlement.ts` / `lnRail.ts`):
    deterministic preimage/payment-hash derivation, hold lifecycle state
    machine, settle/cancel decisions.
  - **Panel B — Liquid P2WSH/Taproot escrow** (`liquidEscrow.ts` /
    `liquidRail.ts`): M-of-N CHECKMULTISIG and judge/refund Taproot script
    trees, BIP-173/BIP-350 addresses.

## [0.2.3] — 2026-08-16

### Fixed
- Escrow kind-space references; `escrow.ts` emits no events.

## [0.2.2] — 2026-08-16

### Added
- Escrow lifecycle ledger (`escrow.ts`): bond ownership proofs (BIP-340
  challenge signatures), `pending → locked → returned | slashed_50 |
  slashed_100 | redistributed | failed` state machine, Kleros-style slashing
  math, deterministic integer-exact redistribution plans.
- Juror bond verification (`bondVerification.ts`): Mempool/Esplora evidence
  verifiers, required-bond computation.

## [0.2.1] — 2026-08-15

2026-08-15 hardening release. See `docs/FIXES-2026-08-15.md`.

### Breaking changes for consumers
1. **`addComplaint` returns `boolean`** (was `void`). Ignoring the return
   value is safe; gating on it is the recommended new behavior.
2. **`DkgComplaint` requires `encryptedShareEventId`.** Complaint events
   without `['share', id]` (author = victim) are structurally invalid.
3. **`restoreFromBackup` is stricter**: backups must carry full, consistent
   VSS commitment sets for the session's threshold; legacy relaxed backups
   are rejected (fail-closed). Use `buildBackupPayload` (unchanged) or the
   certified `courtRecovery` module for new backups.
4. **Legacy NIP-59 unwraps now verify**; wraps that do not verify return
   `null`.

### Changed
- DKG complaints are possession-bound and victim-authored (kind 38032).
- `unwrapProtocolEvent(s)` run the same gate as the signer path: recipient
  `p` tag, seal Schnorr signature, seal-author === rumor-author, rumor-id
  recomputation.
- `restoreFromBackup` recomputes the full verification battery (ordered
  indices, per-participant commitment counts, group key, every verification
  share, full-point parity-exact local share check).
- `seededScalar` counter encoded as a full uint16 (no truncation collision).

## [0.2.0] — 2026-08-14

Initial release: BAO Court — FROST threshold oracle (AGPL-3.0).

- Jury selection (`selection.ts`) — seed-derived, verifiable roster draw.
- Pedersen/PedPop DKG (`dkg.ts`, `independentDkg.ts`) — fail-closed, private
  blame, share backups.
- Commit/reveal voting state machine (`courtVoteMachine.ts`) with canonical
  verdict hashing.
- FROST signing state machine (`courtSigningMachine.ts`, `signing.ts`,
  `independentSigning.ts`) — nonce-equivocation aborts, frozen-verdict
  signing.
- Court session parameters and canonical encoding (`courtSession.ts`,
  `courtProtocolEvents.ts`).
- Nostr event builders/parsers (`events.ts`, `dkgMessages.ts`), NIP-44 v2
  encryption and NIP-59 gift wraps (`nip44Crypto.ts`, `nip59.ts`), external
  signer transport (`courtSigner.ts`, `courtNip46.ts`), durable outbox
  (`courtOutbox.ts`), recipient inbox (`courtInbox.ts`), keeper designation
  (`courtKeeper.ts`), host-key lifecycle (`courtHostKey.ts`), recovery
  (`courtRecovery.ts`), consumer-side attestation validation
  (`validator.ts`).

---

Migration notes for the wire-format breaks (v0.4.0 → v0.5.0) and the
hardening changes (v0.2.x → v0.2.1) are preserved verbatim in
`docs/FIXES-2026-08-18.md` and `docs/FIXES-2026-08-15.md` respectively.
