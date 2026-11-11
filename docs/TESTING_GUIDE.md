# Testing Guide — BAO Court

How the test suite is organized, what each category verifies, and how to add
a test the house way. Read this before writing your first test here.

```
npm test                        # full suite (74 files, 1,656 tests + 1 env-gated live test)
npm run campaign                # scale campaign FAST subset (== the scaleCampaign tests)
npm run campaign:full           # scale campaign FULL corpus → docs/benchmarks/campaign-<date>.json
npx vitest run <file>           # one file
npx vitest run -t "name"        # by test name
npm run typecheck:tests         # tsc over __tests__ (CI gate, same as tests)
```

CI (`.github/workflows/ci.yml`) runs `npm run typecheck:tests` + `npm test`.
Every test must pass deterministically — no sleeps, no `Date.now()`, no
`Math.random()` in assertions.

---

## The suite map

| Category | Files | What it verifies |
|---|---|---|
| **Unit** | `courtVoteMachine.test.ts`, `courtConfirmationMachine.test.ts`, `courtDkgMachine.test.ts`, `courtSigningMachine.test.ts`, `dkg.test.ts`, `signing.test.ts`, `events.test.ts`, `validator.test.ts`, `epochCohort.test.ts`, `selection.test.ts`, `dispute.test.ts`, `nip59.test.ts`, `lnRail.test.ts`, `liquidAddress.test.ts`, … | One module per file: happy paths, constructor validation, hash bindings, canonical encodings. The `court*.test.ts` files also carry the per-machine F-findings locks (e.g. the F-12 monotonic clock ledger). |
| **Adversarial** | `adversarialMachines.test.ts`, `adversarialNostr.test.ts`, `adversarialCrossModule.test.ts`, `adversarialParserFuzz.test.ts`, `attestationValidator.adversarial.test.ts`, `courtRelayAdversary.test.ts` | Hostile input: malformed fields, tampered/forged state objects, illegal event sequences, relay-level drop/replay/reorder. Contract under attack: **every rejection is a TYPED error from the module's own error class** — an uncaught TypeError escaping is a bug. |
| **Property** | `propertiesBatch.test.ts`, `propertiesConfirmation.test.ts`, `propertiesValidator.test.ts` | Invariant sweeps over seeded-random instances (P*/PB*/PV* labels): proofs verify and no single mutation escapes, freeze discipline on every state, typed errors under hostile probes. |
| **Model checking** | `modelChecking.test.ts` + `modelCheckingCore.ts` (+ `scripts/model-check.mjs`, `__fixtures__/model-check-summary.json`) | Exhaustive finite-state-space exploration of the three ceremony machines. `npm test` runs REDUCED inline instances + asserts the committed full-sweep fixture; the FULL sweep is the standalone script (see the header of `modelChecking.test.ts` — read it before touching instance lists; CI would die if the multi-million-state instances moved inline). |
| **Parity / differential** | `differentialParity.test.ts` + `reference/` | Every critical pure function reimplemented independently (`__tests__/reference/`) and asserted to agree across exhaustive inputs. Reference code is deliberately dependency-free and must stay independent — do NOT refactor it to use the helpers. |
| **Pipeline / E2E** | `confirmationPipeline.test.ts`, `settlementE2E.test.ts`, `simulateCourt.test.ts`, `multiRoundLadder.test.ts` | Modules interlocking with real cryptography: cohort → confirmation machine → verdict → Merkle batch → attestation → finality binding → epoch handoff. |
| **Invariant assertions** | `invariantAssertions.test.ts` | The INV-X-* cross-machine invariants from `docs/FORMAL_INVARIANTS.md`, expressed as executable fixtures (deadline precedence, monotonic ledger, signed-domain separation). |
| **Regressions / findings** | `regressions.test.ts`, `r3Findings.test.ts`, `hardening20260815.test.ts` | Every past finding is a permanent named lock (r3-1, F-12, …). New findings get a test here, named after the finding. |
| **Mutation closure** | `mutationClosures.test.ts` | Pins C1–C9: each asserts the one boundary a mutant moved in `scripts/mutation/` (`docs/MUTATION_TESTING.md`). A pin must fail when its mutant is re-applied — the sweep proves it does. |
| **Vectors / crypto audit** | `cryptoLiteratureAudit.test.ts` | Known-answer vectors from the cryptographic literature (RFC 6962-style folds, NIP-44 vectors). |
| **Escrow / rails** | `escrow.test.ts`, `taprootSpend.test.ts`, `lnSettlement.test.ts`, `bondVerification.test.ts`, `liquidEscrow.test.ts` | Settlement-rail contracts against the fakes/real-minicraft scripts (Taproot key-path spends, LN hold invoices, covenant PSETs). |
| **Scale campaign** | `scale/scaleCampaign.test.ts` + `scale/*Corpus.ts` (`scripts/campaign/run-campaign.mjs`) | The large-corpus campaigns over six production surfaces — confirmation sequences, plurality tallies, Merkle batches, signed v2 attestations, jury selection, canonical encodings. `npm test` runs the declared FAST subset; the FULL corpus is the standalone runner, whose JSON artifact is committed under `docs/benchmarks/`. Read `docs/benchmarks/SCALE_CAMPAIGN.md` before changing a corpus size or the artifact. |
| **Live (env-gated)** | `taprootSpend-live.test.ts` | Real-network spend; skipped unless `BAO_LIVE_TAPROOT=true` (`npm run test:live`). The `1 skipped` in every run is this file. |

Category markers in `describe` titles are the convention: a file's describes
read `adversarial: …`, `regression: …`, `INV-X-5: …`, `multi-round ladder: …`,
`monotonic clock ledger (finding F-12)`, `exhaustive model checking — …`.
File names carry the category prefix too (`adversarial*`, `properties*`,
`modelChecking*`); a file name is a category label only when the describes
agree with it.

---

## The helpers kit (`__tests__/helpers/`)

One shared kit — `import { … } from './helpers'` (or a specific module). If
you are about to hand-roll a fixture factory, an id builder, or a seeded
generator, stop: it's probably here.

### `rng.ts` — the ONE seeded generator

```ts
import { mulberry32, int, pick, hex32, uniqueHex32, secFrom, childRng } from './helpers';
const r = mulberry32(4242);          // the house LCG
const n = int(r, 1, 5);              // uniform int in [1,5]
const id = hex32(r);                 // 64 hex chars
const key = secFrom(r);              // 32 random bytes from the stream
const rc = childRng(1000, 'salts');  // labeled child stream — no cross-talk
```

**Determinism rules:**
- Every generator-driven test names its seed literal in the body
  (`mulberry32(4242)`) — a failure is reproducible from the seed alone.
- One logical stream per concern: use `childRng(SEED, 'label')` per fixture
  family rather than threading one generator through two fixtures (a change
  to one fixture's draw count would shift every downstream value).
- Never `Math.random()` / `Date.now()` in a test. If it needs entropy, it's
  a `keys.ts` CSPRNG fixture, and uniqueness — not reproducibility — is the
  point (uniqueness assertions stay value-independent).

### `ids.ts` — deterministic hex ids

```ts
hexId('a')       // 'aaaa…' (64)      — single-char synthetic id
padHexId('c10')  // 'c1000…'          — readable per-index event ids
repeatHexId('d1')// 'd1d1…d1'         — generalized filler
byteHexId(0xb0)  // 'b0b0…'           — id from a small int
```

### `keys.ts` — keypair fixtures (two flavors, documented)

```ts
import { seckey, nostrPubkey, hostPubkey, schnorrKeypair, schnorrKeypairHex } from './helpers';
```

1. **Deterministic (default, JSDOM-SAFE):** `seckey(3)` = 32 bytes ending in
   `0x03`; `nostrPubkey(byte)` / `hostPubkey(byte)` derive the x-only /
   compressed pubkeys. Touches **no CSPRNG** — no `crypto.getRandomValues`,
   no `node:crypto` — so it behaves identically in plain Node vitest,
   jsdom/browser environments, and old WebViews. Use it unless a test needs
   unique keys.
2. **CSPRNG-backed:** `schnorrKeypair()` (`sec: Uint8Array`) /
   `schnorrKeypairHex()` (`sec: string`) via `node:crypto.randomBytes`.
   Node-flavored environments; keep out of generator-driven property tests.

### `machines.ts` — create + drive the ceremony machines

```ts
import { voteMachine, voteCommitEvent, voteRevealEvent, voteClosedReveals,
         confirmationMachine, confirmHashFor, confirmationAt,
         confirmHappyPath, confirmChallengedTo, drive,
         signingMachine, dkgMachine } from './helpers';

// Create with house defaults (adversarialMachines convention: roster 1..3,
// deadlines 100/200, sessionHash 'aa'-style '11'.repeat(32)):
const s = voteMachine();                       // or voteMachine({ allowedOutcomes: ['no','yes'], commitDeadline: 200, … })
const ev = voteCommitEvent(1, 'YES');          // session-bound commit hash, house event-id/now conventions

// Scenario steppers:
voteClosedReveals(['YES', 'NO']);              // commit+reveal each outcome, ends after close_reveals
confirmationAt('ladder_pending');              // confirmation machine at ANY phase
confirmHappyPath(opts);                        // quorum confirmations → fee_settlement, no challenge
confirmChallengedTo([[1,'YES','g'],[2,'NO','h']], opts); // challenge → ladder round 1 → concede

// Generic reducer sequence driver:
drive(state, events, reduceCourtVoteMachine);

signingMachine();                              // defaults: threshold 2, deadline 500, outcome 'yes'
dkgMachine();                                  // defaults: roster [1,2], deadline 1000
```

Every factory takes an options object; every field is overridable; every
clock is a literal. If a scenario stepper you need is missing, ADD it here
instead of copying one from a sibling test file.

### `fixtures.ts` — committed fixtures

- `loadModelCheckSummary()` — the `__fixtures__/model-check-summary.json`
  reader (typed). Model-check tests assert this fixture; never re-inline
  `readFileSync` plumbing.
- `buildV2AttestationEvent(fields, signer, publisherSecret?)` + `V2Fields` —
  the signed kind-89 V2 attestation builder shared by the validator suites.
- `juror(idx, pubkey?)` — deterministic `SelectedJuror` (derived pubkey,
  10k-sat bond, priority = idx).
- `jurorWithKeys(count)` — the independent-DKG variant with real CSPRNG
  keypairs.

### `asserts.ts` — discipline asserts

```ts
import { expectTypedOrOk, captureError, assertDeeplyFrozen,
         assertConfirmationStateFrozen, assertClockMonotonic } from './helpers';

expectTypedOrOk(() => reduce(state, hostileEvent), CourtVoteTransitionError);
const err = captureError(() => reduce(state, bad));   // undefined if no throw
assertDeeplyFrozen(state, 'state');                   // every reachable object frozen
assertConfirmationStateFrozen(state);                 // + every confirmation ledger/record
assertClockMonotonic(before, after);                  // latestTimestamp never rolls back
```

House rules encoded here: hostile input fails closed with the module's OWN
typed error; every machine-returned state is deeply frozen; the F-12 clock
ledger is monotonically non-decreasing.

---

## Adding a test the house way

1. **Pick the file by category** (map above), not by module admiration. A
   new adversarial case for an existing machine belongs in the machine's
   adversarial/section or `adversarialMachines.test.ts`; a new invariant is
   `invariantAssertions.test.ts` + an entry in `docs/FORMAL_INVARIANTS.md`.
2. **Import helpers, don't copy them.** `hexId` for ids, `mulberry32` seeds
   for randomness, `voteMachine()`/`confirmationMachine()` for machine
   states, `assertDeeplyFrozen`/`expectTypedOrOk` for the disciplines.
3. **Clocks are literals.** `now: 100`, never `Date.now()`. Deadlines come
   from the same literals the stepper used.
4. **A regression gets a named lock.** `it('r4-2: <what was broken and the
   contract that failed>')` in `regressions.test.ts` (or the file that owns
   the finding family), and a line in `docs/FORMAL_INVARIANTS.md` if it is
   an invariant.
5. **Determinism budget:** generator-driven tests must pass on any machine —
   keep per-test work bounded; model-check instance additions belong in the
   REDUCED inline lists or the standalone script, per the run-mode split at
   the top of `modelChecking.test.ts`.
6. **Reference code stays independent.** `__tests__/reference/` exists
   precisely because it does NOT share code with production or the helpers.
   Never "deduplicate" it into the kit.
7. **Typecheck:** helpers and tests live under `tsconfig.test.json`
   (`npm run typecheck:tests`). `npm run typecheck` excludes `__tests__` —
   the published surface can't see your fixture.

### What NOT to migrate into helpers

- `__tests__/reference/*` — independence is the feature (differential
  parity).
- `__tests__/modelCheckingCore.ts` — framework-free by design (runs under
  both vitest and `scripts/model-check.mjs`); its adapters stay self-contained.
- Files whose fixtures are contract-bound to recorded values (golden
  hashes/snapshots) — moving a fixture must not move a single asserted byte.
