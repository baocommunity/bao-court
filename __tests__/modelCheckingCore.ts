// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Model-checking CORE: the exhaustive finite-state-space explorer for the
 * three BAO Court phase machines (v0.9.3): `courtVoteMachine`,
 * `courtConfirmationMachine`, and `courtSigningMachine`. This module is
 * framework-free (no vitest) so it runs in BOTH consumers below.
 *
 * ─── RUN-MODE SPLIT (keep npm test fast; keep the full sweep reproducible) ──
 *
 *   FULL exhaustive sweep (the publishable numbers — multi-million-state
 *   instances, several minutes of wall time):
 *
 *       npx tsx scripts/model-check.mjs           # full sweep, writes the fixture
 *       npx tsx scripts/model-check.mjs --fast    # skips vote n=4 (CI-friendly)
 *
 *     The script writes `__fixtures__/model-check-summary.json`; the vitest
 *     suite asserts that committed fixture (presence, all-green invariants)
 *     and cross-checks two cheap instances by re-exploring them.
 *
 *   REDUCED inline sweep (this module imported by
 *   `__tests__/modelChecking.test.ts`): vote n ≤ 3 and reduced-clock
 *   confirmation instances so `npm test` stays bounded (measured ≈ 9 minutes
 *   wall for the whole modelChecking file on the 16-core reference machine).
 *   NEVER move
 *   the n=4 / full-clock instances into the vitest suite — CI would die.
 *
 * ─── METHODOLOGY ────────────────────────────────────────────────────────────
 *
/**
 * Exhaustive finite-state-space model checking of the three BAO Court phase
 * machines (v0.9.3): `courtVoteMachine`, `courtConfirmationMachine`, and
 * `courtSigningMachine`.
 *
 * ─── METHODOLOGY ────────────────────────────────────────────────────────────
 *
 * For each bounded instance (roster size n, outcome count k, deadline pair,
 * ladder-round cap) an exhaustive explorer enumerates EVERY reachable state
 * by BFS/DFS over ALL event applications: every event type crossed with every
 * field-value combination inside the instance's bounds — including ILLEGAL
 * values (non-roster indices, non-hex ids, outcomes outside the frozen
 * ballot, backwards / fractional / negative timestamps, unknown event types,
 * non-object events, commits in the legacy sessionless format, commit-reveal
 * mismatches). The explorer records, for every (state, event) application,
 * whether the reducer returned a successor or threw — and if it threw, that
 * the error is the machine's OWN typed error class
 * (`CourtVoteTransitionError` / `CourtConfirmationTransitionError`), never a
 * raw `TypeError` / `RangeError`.
 *
 * At EVERY reachable state the explorer asserts:
 *
 *   P1 (phase legality)   phase ∈ the machine's declared phase set;
 *   P2 (data invariants)  phase-specific structural invariants — commits ⊆
 *                         roster with no duplicate index, reveals ⊆ commits,
 *                         reveal/commit hashes well-formed and session-bound
 *                         (REAL sha256 commit-reveal matching via the
 *                         machine's own `hashCourtVoteCommit`), unique
 *                         indices, outcome-allowlist membership, verdict ⇔
 *                         phase coherence, failure ⇔ expired/aborted,
 *                         configuration immutability, deep-frozen state,
 *                         monotonic clock along every edge, and (at terminal
 *                         phases) that the verdict is exactly the
 *                         recomputation of the tally from the ledger;
 *   P3 (no dead ends)     every reachable NON-terminal state either can
 *                         reach a non-`aborted` terminal phase
 *                         (`tally_final`/`expired`, resp. `final`/`expired`)
 *                         through legal non-abort progress events, or is
 *                         exactly one of the machine's documented parkable
 *                         states (see THEOREM below) — a stuck state outside
 *                         that set is a liveness bug;
 *   P4 (termination)      the progress graph (legal, state-changing,
 *                         non-abort edges) is acyclic — verified by Kahn's
 *                         algorithm — so under weak fairness (an infinite
 *                         run must eventually take a state-changing event or
 *                         sit in a terminal) every legal behavior
 *                         terminates; idempotent re-applications (duplicate
 *                         commit / no-op tick) appear only as self-loops and
 *                         are counted, not treated as cycles;
 *   P5 (determinism)      for a sampled set of ≥ 200 reachable states per
 *                         instance, the event sequence from creation is
 *                         replayed and must reproduce the identical state
 *                         (key AND full JSON), twice.
 *
 *   THEOREM asserted per instance (P3, biconditional form): a reachable
 *   non-terminal state CANNOT reach a non-aborted terminal IF AND ONLY IF it
 *   is one of the machine's own fail-closed parking states — i.e. a
 *   tick-exempt phase whose resolving transition (`finalize_tally`,
 *   `resolve_round`, `finalize`) provably refuses the frozen ledger (empty
 *   reveal/vote ledger, or a ledger that cannot pass the machine's own
 *   barrier: duplicate event ids), plus — confirmation machine only —
 *   `ladder_pending` at the top of the bounded clock universe (see limits).
 *   The explorer derives the parking predicate by PROBING the machine itself
 *   (no mirrored guard logic) and asserts the biconditional in both
 *   directions.
 *
 * ─── ABSTRACTION LIMITS (documented per the paper's evaluation section) ────
 *
 *   L1 Time is bounded and symbolic: the clock takes values in
 *      {0..25} (T_MAX = 25) with fixed deadlines (commit/confirm = 10,
 *      reveal/challenge = 20) for the VOTE machine; the CONFIRMATION
 *      machine's publishable instances use a reduced but boundary-complete
 *      universe {0..14} with deadlines 6/12 (its ledger combinatorics —
 *      quorum × challengers × ladder rounds — dominate the state space, so
 *      the full-clock confirmation sweep does not fit the runtime budget;
 *      the reduced universe is recorded in each instance name and in the
 *      summary fixture). Guards are exercised at their exact boundary
 *      values (d, d as accept-attempt, d±1). Wall-clock semantics, real
 *      deadline durations, and timeouts are NOT modelled. An infinite legal
 *      sequence in the unbounded clock reduces to the bounded analysis: the
 *      clock is monotonically non-decreasing, so any infinite run is
 *      eventually constant-clock, i.e. a cycle in the bounded graph — which
 *      P4 rules out (modulo no-op self-loops).
 *   L2 Crypto is real but small: commit-reveal matching runs the machine's
 *      actual SHA-256 domain-separated `hashCourtVoteCommit` over a fixed
 *      salt; hashes are treated as opaque values (no collision search).
 *   L3 Roster indices are bounded: vote n ≤ 4; confirmation n = 3 (the
 *      machine refuses n < 3 at creation — round-3 finding r3-6 — and its
 *      ledger combinatorics put n = 4 outside the runtime budget). Creation
 *      rejection of n ∈ {1,2} is asserted separately. The bounded results do
 *      NOT prove n = 201 (state explosion); the properties asserted are
 *      STRUCTURAL (phase legality, uniqueness, ledger barriers, tally
 *      re-derivation) and are size-independent by construction — no
 *      size-dependent claim is made beyond the explored bounds.
 *   L4 `open_ladder_round` roster expansion (`roundRoster`) is explored in
 *      one dedicated instance (identity panel); other instances use the
 *      default case roster as round panel. Multi-challenger ledgers are
 *      explored in one dedicated instance; larger instances bound challenges
 *      to a fixed challenger (challenge guards are per-index identical).
 *   L5 Duplicate event-id CONFIRMATION ledgers (two jurors sharing one event
 *      id — legal at `accept_confirmation`, refused by the finalize barrier)
 *      are explored in one dedicated instance; the mass-vote counterpart is
 *      explored likewise. Challenge event-id duplication is the same barrier
 *      class (code-inspected, not state-explored).
 *   L6 The F-12 clock ledger (v0.9.2+) is a monotonic `latestTimestamp` field
 *      on every ceremony machine — vote, confirmation, DKG, and signing. The
 *      explorer's symbolic-time abstraction merges states equal except
 *      `latestTimestamp` into one abstract state (`abstractKeyOf` drops the
 *      ledger slot): the ledger is a pure observational mirror of the event
 *      history, so the merge is sound and field-agnostic. The generic edge
 *      check asserts ledger monotonicity along EVERY explored edge, and the
 *      signing instances (this extension) exercise the abstraction against
 *      the F-12 ledger in a second machine class — `courtDkgMachine` carries
 *      the identical field shape and is covered by the same argument (a full
 *      DKG adapter is future work).
 *   L7 The crypto-audit A-1 contract (v0.9.3) — a reveal set must equal its
 *      commitment set — is verified at the MACHINE level: `close_commitments`
 *      freezes `finalizedSignerSet`, `accept_partial` refuses any signer
 *      outside it, and the reducer re-derives `finalizedSignerSet ==`
 *      distinct sorted commitment indices at EVERY reduce entry. The signing
 *      instances verify this exhaustively (every interleaving of commits,
 *      closes, partials, equivocations, and aborts at n ≤ 3 (n = 4 is out of
 *      the runtime budget — the machine re-validates every stored commitment
 *      against the curve on EVERY reduce), including nonce- and
 *      partial-equivocation paths to `aborted_peer`.
 *
 * ─── FINDINGS (see PR body for the full write-up) ──────────────────────────
 *
 *   F1 (reported, by design) The vote machine's `reveal_closed` and the
 *       confirmation machine's `ladder_vote_closed` / `fee_settlement` are
 *       tick-EXEMPT; when their ledger cannot pass the resolution barrier
 *       (e.g. zero reveals/votes — closing an empty ledger is explicitly
 *       legal and test-documented), the only exit is `abort`. The explorer
 *       verifies these are the ONLY such states (biconditional).
 *   F2 (reported, asymmetry) `close_confirmations` fails closed on a missing
 *       quorum, but the vote machine's `close_commits` has no quorum analog
 *       (the vote machine has no quorum parameter) — zero-commit vote
 *       ceremonies can always be closed into the F1 parking state.
 *   F3 (reported, minor) `abort` accepts any reason string, including ''
 *       (unvalidated, stored verbatim in `failure.reason`).
 *   F4 (reported, minor) `record_fee` is accepted in EVERY non-terminal
 *       phase, not only `fee_settlement` (phase-agnostic ledger append).
 *   F5 (verified, no bug) No reachable state violates P1–P5; no illegal
 *       event escapes with a raw TypeError/RangeError; the progress graph
 *       is acyclic in every instance.
 *   F6 (verified, no bug — v0.9.3 extension) The signing machine's
 *       fail-closed ledger barriers hold exhaustively at n ≤ 3: the frozen
 *       signer set always equals the distinct commitment set (A-1), partials
 *       are only ever accepted from it, nonce/partial equivocation aborts
 *       with the right blame, and every non-terminal state can still reach
 *       `attestation_published` or `expired` via tick (no parking states —
 *       tick expiry is expressible from every non-terminal state).
 */

/* eslint-disable no-console */

import {
  CourtVoteTransitionError,
  compareOutcomeUtf8,
  createCourtVoteMachine,
  hashCourtVoteCommit,
  reduceCourtVoteMachine,
  type CourtVoteMachineEvent,
  type CourtVoteMachineState,
} from '../courtVoteMachine';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  CourtSigningTransitionError,
  createCourtSigningMachine,
  hashCourtSigningSession,
  reduceCourtSigningMachine,
  type CourtSigningMachineEvent,
  type CourtSigningMachineState,
} from '../courtSigningMachine';
import { HEX_32 } from '../courtCeremonyCore';
import { isValidSecp256k1Point } from '../crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// ─── shared exploration infrastructure ──────────────────────────────────────

/** Bounded clock universe: every `now` the explorer may emit. */
export const T_MAX = 25;
/** Fixed deadline pair for both machines (boundary values of T_MAX). */
export const DEADLINE_A = 10; // commit / confirm deadline
export const DEADLINE_B = 20; // reveal / challenge deadline

export const hex = (c: string): string => c.repeat(64);
const BAD_HEX = `zz${'a'.repeat(62)}`;

/** Deterministic model-check assertion (hot path — no vitest expect). */
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`MODEL CHECK FAILED: ${message}`);
}

function eqArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Clock candidates for deadline-bearing control events: the current clock,
 * one step up, and every guard boundary at/above the clock. Bounded and
 * deterministic — this is what makes the state space finite.
 */
function nowCandidates(
  latest: number,
  deadlineA: number = DEADLINE_A,
  deadlineB: number = DEADLINE_B,
  tMax: number = T_MAX,
): number[] {
  const candidates = new Set<number>([latest]);
  if (latest + 1 <= tMax) candidates.add(latest + 1);
  for (
    const boundary of [deadlineA, deadlineA + 1, deadlineB, deadlineB + 1, deadlineB + 2, tMax]
  ) {
    if (boundary >= latest && boundary <= tMax) candidates.add(boundary);
  }
  return [...candidates].sort((a, b) => a - b);
}

/** One-step clock candidates for ledger-accepting events. */
function stepCandidates(latest: number, cap: number): number[] {
  const candidates = new Set<number>([latest]);
  const next = Math.min(latest + 1, cap);
  if (next >= latest) candidates.add(next);
  return [...candidates].sort((a, b) => a - b);
}

export interface ExploreStats {
  readonly name: string;
  readonly states: number;
  readonly abstractStates: number;
  readonly progressEdges: number;
  readonly selfLoops: number;
  readonly applications: number;
  readonly typedThrows: number;
  readonly rawThrows: number;
  readonly illegalChecks: number;
  readonly terminalStates: number;
  readonly terminalPhaseCounts: Record<string, number>;
  readonly parkingStates: number;
  readonly parkingKinds: Record<string, number>;
  readonly tallyReachableStates: number;
  readonly determinismPathsReplayed: number;
  readonly wallMs: number;
}

export interface MachineAdapter<S> {
  readonly name: string;
  create: () => S;
  phaseOf: (s: S) => string;
  isTerminal: (s: S) => boolean;
  /** Non-aborted terminal (`tally_final`/`expired`, resp. `final`/`expired`). */
  isAcceptingTerminal: (s: S) => boolean;
  keyOf: (s: S) => string;
  /** Two states equal except `latestTimestamp` share one abstract state. */
  abstractKeyOf: (s: S) => string;
  /** ALL events to try: legal shape + illegal values, within bounds. */
  genEvents: (s: S) => { events: unknown[]; illegalCount: number };
  isAbort: (e: unknown) => boolean;
  checkInvariants: (s: S) => void;
  reduce: (s: S, e: unknown) => S;
  ErrorClass: new (message: string) => Error;
  /**
   * The documented parking predicate P(s): non-null exactly when a
   * non-terminal state provably cannot reach a non-aborted terminal. Derived
   * by probing the machine itself, never by mirroring its guards.
   */
  parkingKind: (s: S) => string | null;
  maxStates: number;
}

/**
 * Exhaustive reachability explorer: BFS over all events, per-state
 * invariants, typed-error recording, Kahn cycle check, liveness
 * biconditional, and sampled-path determinism replay.
 */
export function exploreMachine<S>(adapter: MachineAdapter<S>): ExploreStats {
  const startedAt = Date.now();
  const initial = adapter.create();
  adapter.checkInvariants(initial);

  const indexOf = new Map<string, number>();
  const states: S[] = [];
  const parent: number[] = [];
  const parentEvent: unknown[] = [];
  /** Progress edges (state-changing, non-abort) — for cycles + liveness. */
  const adj: number[][] = [];
  const abstractSeen = new Set<string>();
  const queue: number[] = [];

  const pushState = (s: S, key: string, parentIdx: number, via: unknown): number => {
    const idx = states.length;
    indexOf.set(key, idx);
    states.push(s);
    parent.push(parentIdx);
    parentEvent.push(via);
    adj.push([]);
    abstractSeen.add(adapter.abstractKeyOf(s));
    queue.push(idx);
    return idx;
  };

  pushState(initial, adapter.keyOf(initial), -1, null);

  let progressEdges = 0;
  let selfLoops = 0;
  let applications = 0;
  let typedThrows = 0;
  let rawThrows = 0;
  let illegalChecks = 0;
  const rawThrowSamples: string[] = [];

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const s = states[idx];
    adapter.checkInvariants(s);
    const { events, illegalCount } = adapter.genEvents(s);
    illegalChecks += illegalCount;
    const sourceKey = adapter.keyOf(s);

    for (const event of events) {
      applications += 1;
      let next: S;
      try {
        next = adapter.reduce(s, event);
      } catch (err) {
        if (err instanceof adapter.ErrorClass) {
          typedThrows += 1;
        } else {
          rawThrows += 1;
          if (rawThrowSamples.length < 8) {
            const e = err as Error | undefined;
            rawThrowSamples.push(`${e?.name ?? typeof err}: ${e?.message ?? String(err)}`);
          }
        }
        continue;
      }

      // Edge-level checks: freeze discipline and monotonic clock.
      check(Object.isFrozen(next), `${adapter.name}: successor state must be frozen`);
      check(
        (next as unknown as { latestTimestamp: number }).latestTimestamp
          >= (s as unknown as { latestTimestamp: number }).latestTimestamp,
        `${adapter.name}: clock must be monotonic along every edge`,
      );

      const targetKey = adapter.keyOf(next);
      if (targetKey === sourceKey) {
        selfLoops += 1; // idempotent re-application (duplicate event / no-op)
        continue;
      }
      progressEdges += 1;
      let targetIdx = indexOf.get(targetKey);
      if (targetIdx === undefined) {
        adapter.checkInvariants(next);
        targetIdx = pushState(next, targetKey, idx, event);
      }
      if (!adapter.isAbort(event)) adj[idx].push(targetIdx);
    }

    check(
      states.length <= adapter.maxStates,
      `${adapter.name}: state space exceeded the ${adapter.maxStates}-state sanity bound`,
    );
  }

  const total = states.length;

  // ── P4: termination — the progress graph must be acyclic (Kahn). ──
  const indegree = new Uint32Array(total);
  for (let i = 0; i < total; i += 1) {
    for (const j of adj[i]) indegree[j] += 1;
  }
  const topo: number[] = [];
  const ready: number[] = [];
  for (let i = 0; i < total; i += 1) if (indegree[i] === 0) ready.push(i);
  while (ready.length > 0) {
    const i = ready.pop()!;
    topo.push(i);
    for (const j of adj[i]) {
      indegree[j] -= 1;
      if (indegree[j] === 0) ready.push(j);
    }
  }
  check(
    topo.length === total,
    `${adapter.name}: progress graph contains a cycle — an infinite legal event sequence exists (liveness bug)`,
  );

  // ── P3: graceful liveness — reachability of a non-aborted terminal. ──
  // Reverse topological sweep (children precede parents in the reversed
  // Kahn order). canReachAccepting[i] ⟺ a non-aborted terminal is reachable
  // via legal non-abort progress events.
  const canReachAccepting = new Uint8Array(total);
  for (let k = total - 1; k >= 0; k -= 1) {
    const i = topo[k];
    if (adapter.isAcceptingTerminal(states[i])) {
      canReachAccepting[i] = 1;
      continue;
    }
    for (const j of adj[i]) {
      if (canReachAccepting[j] === 1) {
        canReachAccepting[i] = 1;
        break;
      }
    }
  }

  // ── P3 biconditional: parking states are EXACTLY the non-graceful ones. ──
  const parkingKinds: Record<string, number> = {};
  const terminalPhaseCounts: Record<string, number> = {};
  let parkingStates = 0;
  let terminalStates = 0;
  let tallyReachableStates = 0;
  for (let i = 0; i < total; i += 1) {
    const s = states[i];
    const phase = adapter.phaseOf(s);
    if (adapter.isTerminal(s)) {
      terminalStates += 1;
      terminalPhaseCounts[phase] = (terminalPhaseCounts[phase] ?? 0) + 1;
      continue;
    }
    if (adapter.isAcceptingTerminal(s) || canReachAccepting[i] === 1) tallyReachableStates += 1;
    const kind = adapter.parkingKind(s);
    const graceful = canReachAccepting[i] === 1;
    if (graceful) {
      check(
        kind === null,
        `${adapter.name}: state classified as parkable (${kind}) but CAN reach a non-aborted terminal: ${adapter.keyOf(s)}`,
      );
    } else {
      check(
        kind !== null,
        `${adapter.name}: STUCK STATE (no non-aborted terminal reachable, not a documented parking state): ${adapter.keyOf(s)}`,
      );
      parkingStates += 1;
      parkingKinds[kind!] = (parkingKinds[kind!] ?? 0) + 1;
    }
  }

  // ── P5: determinism — replay sampled paths from creation. ──
  let seed = 0x2545_f491;
  const randomBelow = (m: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
    return seed % m;
  };
  const sampleCount = Math.min(200, total);
  let determinismPathsReplayed = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const target = randomBelow(total);
    const path: unknown[] = [];
    for (let i = target; i >= 0; i = parent[i]) {
      if (parentEvent[i] !== null) path.push(parentEvent[i]);
    }
    path.reverse();
    let replayed = adapter.create();
    for (const event of path) {
      replayed = adapter.reduce(replayed, event); // must not throw: path is legal
    }
    const expected = states[target];
    check(
      adapter.keyOf(replayed) === adapter.keyOf(expected)
        && JSON.stringify(replayed) === JSON.stringify(expected),
      `${adapter.name}: determinism violation — replaying a legal event sequence produced a different state`,
    );
    // Replay the same sequence a second time: identical result, again.
    let replayedTwice = adapter.create();
    for (const event of path) replayedTwice = adapter.reduce(replayedTwice, event);
    check(
      JSON.stringify(replayedTwice) === JSON.stringify(replayed),
      `${adapter.name}: determinism violation — same sequence, different states across replays`,
    );
    determinismPathsReplayed += 1;
  }

  const stats: ExploreStats = {
    name: adapter.name,
    states: total,
    abstractStates: abstractSeen.size,
    progressEdges,
    selfLoops,
    applications,
    typedThrows,
    rawThrows,
    illegalChecks,
    terminalStates,
    terminalPhaseCounts,
    parkingStates,
    parkingKinds,
    tallyReachableStates,
    determinismPathsReplayed,
    wallMs: Date.now() - startedAt,
  };
  // Fail the instance if any non-typed error escaped anywhere.
  check(
    stats.rawThrows === 0,
    `${adapter.name}: ${rawThrows} non-typed error(s) escaped the reducer: ${rawThrowSamples.join(' | ')}`,
  );
  return stats;
}

export function printStats(stats: ExploreStats): void {
  const terminals = Object.entries(stats.terminalPhaseCounts)
    .map(([p, c]) => `${p}=${c}`)
    .join(' ');
  const parking = Object.entries(stats.parkingKinds)
    .map(([k, c]) => `${k}=${c}`)
    .join(' ') || 'none';
  // eslint-disable-next-line no-console
  console.log(
    `[model-checking] ${stats.name}\n`
    + `  states=${stats.states} (abstract=${stats.abstractStates})  progressEdges=${stats.progressEdges}`
    + `  selfLoops=${stats.selfLoops}  applications=${stats.applications}\n`
    + `  terminal: ${terminals || 'none'}  parking: ${parking}\n`
    + `  typedThrows=${stats.typedThrows}  rawThrows=${stats.rawThrows}  illegalEventChecks=${stats.illegalChecks}\n`
    + `  non-aborted-terminal-reachable (incl. terminals)=${stats.tallyReachableStates}/${stats.states}`
    + `  determinismPaths=${stats.determinismPathsReplayed}  wallMs=${stats.wallMs}`,
  );
}

// ─── courtVoteMachine instance ──────────────────────────────────────────────

const VOTE_PHASES = [
  'commit_open',
  'commit_closed',
  'reveal_open',
  'reveal_closed',
  'tally_final',
  'expired',
  'aborted',
] as const;
const VOTE_TERMINAL = new Set<string>(['tally_final', 'expired', 'aborted']);

export const VOTE_SALT = hex('a');
export const VOTE_SALT_OTHER = hex('b');

/** Clears the session-bound version bit: a well-formed but LEGACY commit. */
function legacyVersionOf(commitHash: string): string {
  return ((Number.parseInt(commitHash[0], 16) & 0x7) | 0).toString(16) + commitHash.slice(1);
}

export interface VoteInstanceSpec {
  readonly name: string;
  readonly n: number;
  readonly outcomes: readonly string[];
}

export function voteAdapter(spec: VoteInstanceSpec): MachineAdapter<CourtVoteMachineState> {
  const sessionHash = hex('1');
  const roster = Array.from({ length: spec.n }, (_, i) => i + 1);
  const outcomes = [...spec.outcomes];
  const eventIdOf = (idx: number): string => hex(String(idx));
  // Real session-bound commit hashes — one per outcome, fixed salt (L2).
  const commitHashes = outcomes.map((o) =>
    hashCourtVoteCommit({ sessionHash, outcome: o, salt: VOTE_SALT }),
  );
  const legacyCommit = legacyVersionOf(commitHashes[0]);

  const create = (): CourtVoteMachineState =>
    createCourtVoteMachine({
      sessionHash,
      participantIndices: roster,
      allowedOutcomes: outcomes,
      commitDeadline: DEADLINE_A,
      revealDeadline: DEADLINE_B,
    });

  const checkInvariants = (s: CourtVoteMachineState): void => {
    check(VOTE_PHASES.includes(s.phase as never), `P1: unknown vote phase ${s.phase}`);
    check(Number.isSafeInteger(s.latestTimestamp) && s.latestTimestamp >= 0, 'P2: vote clock');
    check(Object.isFrozen(s), 'P2: vote state frozen');
    check(eqArray(s.participantIndices, roster), 'P2: vote roster immutable');
    check(eqArray(s.allowedOutcomes, outcomes), 'P2: vote ballot immutable');
    check(s.sessionHash === sessionHash, 'P2: vote sessionHash immutable');
    check(s.commitDeadline === DEADLINE_A && s.revealDeadline === DEADLINE_B, 'P2: vote deadlines immutable');

    const committed = new Set<number>();
    for (const c of s.commits) {
      check(roster.includes(c.idx), 'P2: vote commit idx ∈ roster (commits ⊆ roster)');
      check(HEX_32.test(c.commitHash), 'P2: vote commitHash well-formed');
      check(
        (Number.parseInt(c.commitHash[0], 16) & 0x8) !== 0,
        'P2: accepted vote commits carry the session-bound version bit',
      );
      check(HEX_32.test(c.eventId), 'P2: vote commit eventId well-formed');
      check(!committed.has(c.idx), 'P2: no duplicate vote commit idx');
      committed.add(c.idx);
    }
    check(s.commits.length <= roster.length, 'P2: vote commit ledger bounded by roster');

    for (const r of s.reveals) {
      check(committed.has(r.idx), 'P2: reveals ⊆ commits (vote)');
      check(roster.includes(r.idx), 'P2: vote reveal idx ∈ roster');
      check(outcomes.includes(r.outcome), 'P2: vote reveal outcome ∈ frozen ballot');
      check(HEX_32.test(r.salt) && HEX_32.test(r.eventId), 'P2: vote reveal salt/eventId well-formed');
      // Real commit-reveal matching with the machine's own hash (L2).
      check(
        hashCourtVoteCommit({ sessionHash: s.sessionHash, outcome: r.outcome, salt: r.salt })
          === s.commits.find((c) => c.idx === r.idx)!.commitHash,
        'P2: vote reveal matches its session-bound commit',
      );
    }
    const revealed = new Set<number>();
    for (const r of s.reveals) {
      check(!revealed.has(r.idx), 'P2: no duplicate vote reveal idx');
      revealed.add(r.idx);
    }
    check(s.reveals.length <= s.commits.length, 'P2: vote reveals bounded by commits');

    check(
      (s.verdict !== undefined) === (s.phase === 'tally_final'),
      'P2: vote verdict ⟺ tally_final (verdict ⇒ terminal phase)',
    );
    check(
      (s.failure !== undefined) === (s.phase === 'expired' || s.phase === 'aborted'),
      'P2: vote failure ⟺ expired/aborted',
    );
    if (s.phase === 'tally_final' && s.verdict) {
      check(s.reveals.length >= 1, 'P2: tally_final implies ≥1 reveal');
      check(s.verdict.supportingEventIds.length >= 1, 'P2: verdict has supporting evidence');
      check(HEX_32.test(s.verdict.verdictHash), 'P2: verdictHash well-formed');
      check(outcomes.includes(s.verdict.outcome), 'P2: verdict outcome ∈ ballot');
      // Verdict is a pure function of the ledger: recompute the tally.
      const counts = new Map<string, number>();
      for (const r of s.reveals) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
      let winner = '';
      let best = -1;
      for (const [outcome, count] of counts) {
        if (count > best || (count === best && compareOutcomeUtf8(outcome, winner) < 0)) {
          winner = outcome;
          best = count;
        }
      }
      check(s.verdict.outcome === winner, 'P2: verdict outcome = recomputed tally winner');
      const revealIds = new Set(s.reveals.filter((r) => r.outcome === winner).map((r) => r.eventId.toLowerCase()));
      check(
        s.verdict.supportingEventIds.length === revealIds.size
          && s.verdict.supportingEventIds.every((id) => revealIds.has(id)),
        'P2: verdict supporting ids = winning reveal event ids',
      );
      check(
        s.verdict.supportingEventIds.every((id, i) => i === 0 || s.verdict!.supportingEventIds[i - 1] <= id),
        'P2: verdict supporting ids sorted',
      );
    }
  };

  const genEvents = (s: CourtVoteMachineState): { events: unknown[]; illegalCount: number } => {
    const latest = s.latestTimestamp;
    const nows = nowCandidates(latest);
    const commitNows = stepCandidates(latest, DEADLINE_A - 1);
    const revealNows = stepCandidates(latest, DEADLINE_B - 1);
    const events: unknown[] = [];

    if (s.phase === 'commit_open') {
      for (const idx of roster) {
        for (const commitHash of [...commitHashes, legacyCommit]) {
          for (const now of commitNows) {
            events.push({ type: 'accept_commit', idx, commitHash, eventId: eventIdOf(idx), now });
          }
        }
      }
    }
    if (s.phase === 'reveal_open') {
      for (const idx of roster) {
        for (const outcome of outcomes) {
          for (const now of revealNows) {
            events.push({ type: 'accept_reveal', idx, outcome, salt: VOTE_SALT, eventId: eventIdOf(idx), now });
          }
        }
      }
    }
    for (const now of nows) {
      // Full clock sweep only where the control event is phase-legal; other
      // phases get a single probe (the typed-throw path is covered once).
      events.push({ type: 'tick', now });
      if (s.phase === 'commit_open') events.push({ type: 'close_commits', now });
      else events.push({ type: 'close_commits', now: latest });
      if (s.phase === 'commit_closed') events.push({ type: 'open_reveals', now });
      else events.push({ type: 'open_reveals', now: latest });
      if (s.phase === 'reveal_open') events.push({ type: 'close_reveals', now });
      else events.push({ type: 'close_reveals', now: latest });
      if (s.phase === 'reveal_closed') events.push({ type: 'finalize_tally', now });
      else events.push({ type: 'finalize_tally', now: latest });
    }
    events.push({ type: 'abort', reason: 'host-abort' });

    // ── guaranteed-illegal events: must throw the machine's OWN typed error
    // at EVERY reachable state (the explorer asserts this globally). ──
    const illegal: unknown[] = [
      { type: 'accept_commit', idx: 0, commitHash: commitHashes[0], eventId: eventIdOf(1), now: latest },
      { type: 'accept_commit', idx: spec.n + 1, commitHash: commitHashes[0], eventId: eventIdOf(1), now: latest },
      { type: 'accept_commit', idx: roster[0], commitHash: BAD_HEX, eventId: eventIdOf(1), now: latest },
      { type: 'accept_commit', idx: roster[0], commitHash: commitHashes[0], eventId: 'nothex', now: DEADLINE_A },
      { type: 'accept_reveal', idx: 0, outcome: outcomes[0], salt: VOTE_SALT, eventId: eventIdOf(1), now: latest },
      { type: 'accept_reveal', idx: roster[0], outcome: '§bogus§', salt: VOTE_SALT, eventId: eventIdOf(1), now: latest },
      { type: 'accept_reveal', idx: roster[0], outcome: outcomes[0], salt: BAD_HEX, eventId: eventIdOf(1), now: latest },
      // commit-reveal mismatch (wrong salt) — or reveal without any commit
      { type: 'accept_reveal', idx: roster[0], outcome: outcomes[0], salt: VOTE_SALT_OTHER, eventId: eventIdOf(1), now: latest },
      { type: 'accept_reveal', idx: roster[0], outcome: outcomes[0], salt: VOTE_SALT, eventId: eventIdOf(1), now: DEADLINE_B },
      { type: 'close_commits' }, // missing clock
      { type: 'tick', now: -1 },
      { type: 'tick', now: 1.5 },
      { type: 'tick', now: '5' },
      { type: 'galaxy_brain', now: latest },
      null,
      42,
    ];
    if (latest >= 1) illegal.push({ type: 'tick', now: latest - 1 }); // clock rollback
    if (VOTE_TERMINAL.has(s.phase)) illegal.push({ type: 'abort', reason: 'too-late' });
    events.push(...illegal);
    return { events, illegalCount: illegal.length };
  };

  const keyOf = (s: CourtVoteMachineState): string =>
    [
      s.phase,
      s.latestTimestamp,
      s.commits.map((c) => `${c.idx}.${c.commitHash.slice(0, 8)}.${c.eventId.slice(0, 8)}`).join(','),
      s.reveals.map((r) => `${r.idx}.${r.outcome}.${r.eventId.slice(0, 8)}`).join(','),
      s.verdict ? `V:${s.verdict.outcome}.${s.verdict.verdictHash.slice(0, 8)}` : '-',
      s.failure ? `F:${s.failure.phase}.${s.failure.reason}` : '-',
    ].join('|');
  const abstractKeyOf = (s: CourtVoteMachineState): string =>
    keyOf(s).split('|').filter((_, i) => i !== 1).join('|');

  const parkingKind = (s: CourtVoteMachineState): string | null => {
    if (s.phase !== 'reveal_closed') return null;
    // Tick-exempt phase: probe the machine — finalize refuses ⇒ parkable.
    try {
      reduceCourtVoteMachine(s, { type: 'finalize_tally', now: s.latestTimestamp });
      return null;
    } catch (err) {
      check(
        err instanceof CourtVoteTransitionError,
        'parking probe must fail with the machine’s own typed error',
      );
      return 'reveal_closed:finalize-refuses';
    }
  };

  return {
    name: spec.name,
    create,
    phaseOf: (s) => s.phase,
    isTerminal: (s) => VOTE_TERMINAL.has(s.phase),
    isAcceptingTerminal: (s) => s.phase === 'tally_final' || s.phase === 'expired',
    keyOf,
    abstractKeyOf,
    genEvents,
    isAbort: (e) => (e as { type?: string })?.type === 'abort',
    checkInvariants,
    reduce: (s, e) => reduceCourtVoteMachine(s, e as CourtVoteMachineEvent),
    ErrorClass: CourtVoteTransitionError,
    parkingKind,
    maxStates: 1_500_000,
  };
}

// ─── courtConfirmationMachine instance ──────────────────────────────────────

const CONFIRM_PHASES = [
  'confirm_open',
  'confirm_closed',
  'challenge_window',
  'ladder_pending',
  'ladder_vote_open',
  'ladder_vote_closed',
  'round_resolved',
  'fee_settlement',
  'final',
  'expired',
  'aborted',
] as const;
const CONFIRM_TERMINAL = new Set<string>(['final', 'expired', 'aborted']);

export const BOND_TX = hex('b');
export const BOND_PROOF = hex('c');
export const FEE_EVENT = hex('f');
export const MANUAL_REASON = 'manual-audit';

export interface ConfirmInstanceSpec {
  readonly name: string;
  readonly n: number;
  readonly quorum: number;
  readonly maxLadderRounds: number;
  /** Roster indices allowed to file a challenge (L4). */
  readonly challengers: readonly number[];
  /** Confirmation event-id variants: 'own' always; 'shared' adds a dup id (L5). */
  readonly confirmEventIdVariants?: readonly ('own' | 'shared')[];
  /** Mass-vote event-id variants (L5). */
  readonly massVoteEventIdVariants?: readonly ('own' | 'shared')[];
  /** Explore an explicit (identity) roundRoster on open_ladder_round (L4). */
  readonly roundRosterVariant?: boolean;
  /**
   * Reduced clock universe for INLINE (vitest) instances only:
   * [confirmDeadline, challengeDeadline] + top of the clock. Defaults to the
   * full analysis bounds (10, 20, T_MAX=25). Reduced-clock instances are
   * clearly NAMED as such — their numbers are NOT comparable to the full
   * fixture and they never appear in it.
   */
  readonly inlineClock?: readonly [confirmDeadline: number, challengeDeadline: number, tMax: number];
}

export function confirmAdapter(spec: ConfirmInstanceSpec): MachineAdapter<CourtConfirmationMachineState> {
  const sessionHash = hex('2');
  const proposalHash = hex('3');
  const outcomes = ['YES', 'NO'];
  const proposedOutcome = 'YES';
  const roster = Array.from({ length: spec.n }, (_, i) => i + 1);
  const eventIdOf = (idx: number): string => hex(String(idx));
  const sharedEventId = hex('e');
  const [dA, dB, tMax] = spec.inlineClock ?? [DEADLINE_A, DEADLINE_B, T_MAX];
  const confirmHashes = new Map(
    roster.map((idx) => [
      idx,
      hashCourtConfirmation({ sessionHash, proposalHash, idx }),
    ] as const),
  );

  const create = (): CourtConfirmationMachineState =>
    createCourtConfirmationMachine({
      sessionHash,
      proposalHash,
      proposedOutcome,
      allowedOutcomes: outcomes,
      participantIndices: roster,
      confirmQuorum: spec.quorum,
      confirmDeadline: dA,
      challengeDeadline: dB,
      maxLadderRounds: spec.maxLadderRounds,
    });

  const checkInvariants = (s: CourtConfirmationMachineState): void => {
    check(CONFIRM_PHASES.includes(s.phase as never), `P1: unknown confirmation phase ${s.phase}`);
    check(Number.isSafeInteger(s.latestTimestamp) && s.latestTimestamp >= 0, 'P2: confirmation clock');
    check(Object.isFrozen(s), 'P2: confirmation state frozen');
    check(eqArray(s.participantIndices, roster), 'P2: confirmation roster immutable');
    check(eqArray(s.allowedOutcomes, outcomes), 'P2: confirmation ballot immutable');
    check(s.proposedOutcome === proposedOutcome && s.proposalHash === proposalHash, 'P2: proposal immutable');
    check(s.sessionHash === sessionHash, 'P2: confirmation session immutable');
    check(s.confirmQuorum === spec.quorum, 'P2: quorum immutable');
    check(s.confirmDeadline === dA && s.challengeDeadline === dB, 'P2: confirmation deadlines immutable');
    check(s.maxLadderRounds === spec.maxLadderRounds, 'P2: ladder cap immutable');
    check(s.ladderRound >= 0 && s.ladderRound <= s.maxLadderRounds, 'P2: ladderRound within cap');

    // Confirmation ledger: re-derive each canonical binding.
    // Event-id uniqueness across participants is NOT an accept-time machine
    // invariant (the machine enforces it at its resolution barriers; the
    // dup-event-id instance explores those parking states via the probe).
    const confirmIdx = new Set<number>();
    for (const c of s.confirmations) {
      check(roster.includes(c.idx), 'P2: confirmation idx ∈ roster');
      check(HEX_32.test(c.eventId), 'P2: confirmation eventId well-formed');
      check(
        c.confirmHash === hashCourtConfirmation({ sessionHash: s.sessionHash, proposalHash: s.proposalHash, idx: c.idx }),
        'P2: confirmation record matches its canonical session/proposal binding',
      );
      check(!confirmIdx.has(c.idx), 'P2: no duplicate confirmation idx');
      confirmIdx.add(c.idx);
    }
    check(s.confirmations.length <= roster.length, 'P2: confirmation ledger bounded by roster');

    // Challenge ledger.
    const challengeIdx = new Set<number>();
    for (const c of s.challenges) {
      check(roster.includes(c.idx), 'P2: challenge idx ∈ roster');
      check(HEX_32.test(c.bondTxid) && HEX_32.test(c.bondProofHash) && HEX_32.test(c.eventId), 'P2: challenge record well-formed');
      check(!challengeIdx.has(c.idx), 'P2: no duplicate challenge idx');
      challengeIdx.add(c.idx);
    }

    // Ladder coherence.
    check(
      (s.ladder !== undefined) === (s.ladderRound >= 1),
      'P2: ladder defined ⟺ ladderRound ≥ 1',
    );
    if (s.ladder) {
      check(s.ladder.round === s.ladderRound, 'P2: ladder.round = ladderRound');
      check(Number.isSafeInteger(s.ladder.voteDeadline) && s.ladder.voteDeadline >= 1, 'P2: round deadline positive');
      const panel = s.ladder.roundRoster ?? roster;
      if (s.ladder.roundRoster !== undefined) {
        check(s.ladder.roundRoster.length >= 3, 'P2: round panel ≥ 3 seats');
        s.ladder.roundRoster.forEach((idx, offset) => check(idx === offset + 1, 'P2: round panel sequential 1..N'));
      }
      const voteIdx = new Set<number>();
      for (const v of s.ladder.votes) {
        check(panel.includes(v.idx), 'P2: mass vote idx ∈ round panel');
        check(outcomes.includes(v.outcome), 'P2: mass vote outcome ∈ ballot');
        check(HEX_32.test(v.eventId), 'P2: mass vote eventId well-formed');
        check(!voteIdx.has(v.idx), 'P2: no duplicate mass vote idx per round');
        voteIdx.add(v.idx);
      }
    }
    check(
      s.phase === 'ladder_vote_open' || s.phase === 'ladder_vote_closed'
        ? s.ladder !== undefined
        : true,
      'P2: ladder phases carry a ladder',
    );

    // Outcome history: consecutive rounds, nonempty winners, coherent ids.
    s.outcomeHistory.forEach((record, i) => {
      check(record.round === i + 1, 'P2: outcomeHistory rounds consecutive from 1');
      check(outcomes.includes(record.outcome), 'P2: history outcome ∈ ballot');
      check(record.winnerIndices.length >= 1, 'P2: history winner has ≥1 voter');
      check(record.winnerEventIds.length === record.winnerIndices.length, 'P2: history winner ids/indices aligned');
      check(
        record.winnerEventIds.every((id, k) => k === 0 || record.winnerEventIds[k - 1] <= id),
        'P2: history winner ids sorted',
      );
      check(record.winnerIndices.every((idx) => roster.includes(idx)), 'P2: history winner indices ∈ roster');
    });
    check(
      s.outcomeHistory.length <= s.ladderRound,
      'P2: outcomeHistory bounded by rounds opened',
    );

    // Clawback flags: unique (idx, reason, round); known idx.
    const flagKeys = new Set<string>();
    for (const flag of s.clawbackFlags) {
      const key = `${flag.idx}.${flag.reason}.${flag.round}`;
      check(!flagKeys.has(key), 'P2: no duplicate clawback flag per (idx, reason, round)');
      flagKeys.add(key);
      check(roster.includes(flag.idx), 'P2: clawback flag idx ∈ roster');
      check(typeof flag.reason === 'string' && flag.reason.length > 0, 'P2: clawback reason non-empty');
    }

    // Fee ledger.
    const feeIds = new Set<string>();
    for (const fee of s.fees) {
      check(HEX_32.test(fee), 'P2: fee eventId well-formed');
      check(!feeIds.has(fee), 'P2: no duplicate fee eventId');
      feeIds.add(fee);
    }

    // Verdict coherence: pending verdict (hash '') vs minted final verdict.
    check(
      (s.phase === 'final') === (s.verdict !== undefined && s.verdict.verdictHash !== ''),
      'P2: minted verdict ⟺ final phase',
    );
    if (s.verdict) {
      // A pending verdict (the last resolved round's outcome, verdictHash '')
      // legitimately persists through the whole next ladder round: escalate
      // carries it into ladder_pending → ladder_vote_open → ladder_vote_closed,
      // and abort / a ladder_vote_open tick-expiry carry it into
      // aborted / expired. Only the PRE-resolution phases (before any round
      // has resolved) must be verdict-free.
      check(
        !['confirm_open', 'confirm_closed', 'challenge_window'].includes(s.phase),
        `P2: verdict only after a resolved round (found verdict in pre-resolution phase ${s.phase})`,
      );
    }
    check(
      s.phase === 'fee_settlement' || s.phase === 'round_resolved' || s.phase === 'final'
        ? s.verdict !== undefined
        : true,
      'P2: resolved phases carry a verdict',
    );
    check(
      s.phase === 'ladder_pending'
        ? (s.verdict !== undefined) === (s.outcomeHistory.length >= 1)
        : true,
      'P2: ladder_pending verdict ⟺ a round already resolved',
    );
    check(
      (s.failure !== undefined) === (s.phase === 'expired' || s.phase === 'aborted'),
      'P2: confirmation failure ⟺ expired/aborted',
    );
    if (s.phase === 'final' && s.verdict) {
      check(HEX_32.test(s.verdict.verdictHash), 'P2: final verdictHash well-formed');
      check(s.verdict.supportingEventIds.length >= 1, 'P2: final verdict has supporting evidence');
      check(outcomes.includes(s.verdict.outcome), 'P2: final verdict outcome ∈ ballot');
      // Verdict is a pure function of the ledgers: recompute.
      if (s.challenges.length === 0 && s.verdict.upheld) {
        check(
          eqArray(s.verdict.supportingEventIds, s.confirmations.map((c) => c.eventId.toLowerCase()).sort()),
          'P2: never-challenged final verdict backed by the confirmation ledger',
        );
        check(s.verdict.outcome === proposedOutcome, 'P2: never-challenged verdict = proposed outcome');
      } else {
        const lastRound = s.outcomeHistory[s.outcomeHistory.length - 1];
        check(lastRound !== undefined, 'P2: challenged verdict needs a resolved round');
        check(s.verdict.outcome === lastRound.outcome, 'P2: final verdict = last resolved round winner');
        check(
          s.verdict.upheld === (lastRound.outcome === proposedOutcome),
          'P2: upheld flag = last round against proposal',
        );
        const winningIds = (s.ladder?.votes ?? [])
          .filter((v) => v.outcome === s.verdict!.outcome)
          .map((v) => v.eventId.toLowerCase())
          .sort();
        check(eqArray(s.verdict.supportingEventIds, winningIds), 'P2: final verdict backed by winning round votes');
      }
    }
  };

  const genEvents = (s: CourtConfirmationMachineState): { events: unknown[]; illegalCount: number } => {
    const latest = s.latestTimestamp;
    const nows = nowCandidates(latest, dA, dB, tMax);
    const events: unknown[] = [];

    if (s.phase === 'confirm_open') {
      for (const idx of roster) {
        for (const variant of spec.confirmEventIdVariants ?? (['own'] as const)) {
          const eventId = variant === 'shared' ? sharedEventId : eventIdOf(idx);
          for (const now of stepCandidates(latest, tMax)) {
            events.push({ type: 'accept_confirmation', idx, confirmHash: confirmHashes.get(idx)!, eventId, now });
          }
        }
      }
    }
    if (s.phase === 'challenge_window') {
      for (const idx of spec.challengers) {
        for (const now of stepCandidates(latest, dB - 1)) {
          events.push({
            type: 'accept_challenge',
            idx,
            bondTxid: BOND_TX,
            bondProofHash: BOND_PROOF,
            eventId: eventIdOf(idx),
            now,
          });
        }
      }
    }
    if (s.phase === 'ladder_pending') {
      const round = s.ladderRound + 1;
      const voteDeadlineOptions = [...new Set([latest + 1, dB + 1, tMax])]
        .filter((vd) => vd > latest && vd <= tMax)
        .sort((a, b) => a - b);
      const rosters: (readonly number[] | undefined)[] = spec.roundRosterVariant
        ? [undefined, roster]
        : [undefined];
      for (const voteDeadline of voteDeadlineOptions) {
        for (const roundRoster of rosters) {
          events.push({
            type: 'open_ladder_round',
            round,
            voteDeadline,
            ...(roundRoster === undefined ? {} : { roundRoster: [...roundRoster] }),
            now: latest,
          });
        }
      }
    }
    if (s.phase === 'ladder_vote_open' && s.ladder) {
      for (const idx of roster) {
        for (const outcome of outcomes) {
          for (const variant of spec.massVoteEventIdVariants ?? (['own'] as const)) {
            const eventId = variant === 'shared' ? sharedEventId : eventIdOf(idx);
            for (const now of stepCandidates(latest, s.ladder.voteDeadline - 1)) {
              events.push({ type: 'accept_mass_vote', idx, outcome, eventId, now });
            }
          }
        }
      }
    }
    for (const now of nows) {
      events.push({ type: 'tick', now });
      if (s.phase === 'confirm_open') events.push({ type: 'close_confirmations', now });
      else events.push({ type: 'close_confirmations', now: latest });
      if (s.phase === 'confirm_closed') events.push({ type: 'open_challenge_window', now });
      else events.push({ type: 'open_challenge_window', now: latest });
      if (s.phase === 'challenge_window') events.push({ type: 'close_challenge_window', now });
      else events.push({ type: 'close_challenge_window', now: latest });
      if (s.phase === 'ladder_vote_open') events.push({ type: 'close_ladder_round', now });
      else events.push({ type: 'close_ladder_round', now: latest });
      if (s.phase === 'ladder_vote_closed') events.push({ type: 'resolve_round', now });
      else events.push({ type: 'resolve_round', now: latest });
      if (s.phase === 'fee_settlement') events.push({ type: 'finalize', now });
      else events.push({ type: 'finalize', now: latest });
    }
    events.push(
      { type: 'escalate', now: latest },
      { type: 'concede', now: latest },
    );
    if (s.phase === 'fee_settlement') {
      for (const now of stepCandidates(latest, tMax)) {
        events.push({ type: 'record_fee', feeEventId: FEE_EVENT, now });
        events.push({ type: 'flag_clawback', idx: roster[0], reason: MANUAL_REASON, now });
      }
    }
    events.push({ type: 'abort', reason: 'host-abort' });

    // ── guaranteed-illegal events (typed-error assertion at every state). ──
    const wrongRound = s.ladderRound; // never equal to the required +1
    const illegal: unknown[] = [
      { type: 'accept_confirmation', idx: 0, confirmHash: confirmHashes.get(1)!, eventId: eventIdOf(1), now: latest },
      { type: 'accept_confirmation', idx: spec.n + 1, confirmHash: confirmHashes.get(1)!, eventId: eventIdOf(1), now: latest },
      // well-formed hash bound to the WRONG roster index
      { type: 'accept_confirmation', idx: roster[0], confirmHash: confirmHashes.get(roster[roster.length - 1])!, eventId: eventIdOf(1), now: latest },
      { type: 'accept_confirmation', idx: roster[0], confirmHash: confirmHashes.get(roster[0])!, eventId: 'nothex', now: latest },
      { type: 'accept_challenge', idx: 0, bondTxid: BOND_TX, bondProofHash: BOND_PROOF, eventId: eventIdOf(1), now: latest },
      { type: 'accept_challenge', idx: roster[0], bondTxid: BAD_HEX, bondProofHash: BOND_PROOF, eventId: eventIdOf(1), now: latest },
      { type: 'accept_mass_vote', idx: spec.n + 1, outcome: outcomes[0], eventId: eventIdOf(1), now: latest },
      { type: 'accept_mass_vote', idx: roster[0], outcome: '§bogus§', eventId: eventIdOf(1), now: latest },
      { type: 'accept_mass_vote', idx: roster[0], outcome: outcomes[0], eventId: BAD_HEX, now: latest },
      { type: 'open_ladder_round', round: wrongRound, voteDeadline: 21, now: latest },
      { type: 'open_ladder_round', round: wrongRound + 1, voteDeadline: 0, now: latest },
      { type: 'open_ladder_round', round: wrongRound + 1, voteDeadline: latest, now: latest }, // deadline not in the future
      { type: 'open_ladder_round', round: wrongRound + 1, voteDeadline: 21, roundRoster: [1, 2], now: latest }, // panel < 3
      { type: 'flag_clawback', idx: roster[0], reason: '', now: latest },
      { type: 'flag_clawback', idx: 0, reason: MANUAL_REASON, now: latest },
      { type: 'record_fee', feeEventId: BAD_HEX, now: latest },
      { type: 'close_confirmations' }, // missing clock
      { type: 'tick', now: -1 },
      { type: 'tick', now: 1.5 },
      { type: 'tick', now: '5' },
      { type: 'galaxy_brain', now: latest },
      null,
      42,
    ];
    if (latest >= 1) illegal.push({ type: 'tick', now: latest - 1 });
    if (CONFIRM_TERMINAL.has(s.phase)) illegal.push({ type: 'abort', reason: 'too-late' });
    events.push(...illegal);
    return { events, illegalCount: illegal.length };
  };

  const keyOf = (s: CourtConfirmationMachineState): string =>
    [
      s.phase,
      s.latestTimestamp,
      s.confirmations.map((c) => `${c.idx}.${c.eventId.slice(0, 8)}`).join(','),
      s.challenges.map((c) => `${c.idx}.${c.eventId.slice(0, 8)}`).join(','),
      s.ladder
        ? `L${s.ladder.round}.${s.ladder.voteDeadline}.${s.ladder.votes.map((v) => `${v.idx}${v.outcome[0]}${v.eventId.slice(0, 4)}`).join(',')}.${s.ladder.roundRoster ? 'R' : 'D'}`
        : '-',
      s.ladderRound,
      s.outcomeHistory.map((o) => `${o.round}${o.outcome[0]}`).join(','),
      s.clawbackFlags.map((f) => `${f.idx}.${f.reason[0]}.${f.round}`).join(','),
      s.fees.length,
      s.verdict ? `V:${s.verdict.outcome}.${s.verdict.verdictHash === '' ? 'pending' : s.verdict.verdictHash.slice(0, 8)}.${s.verdict.upheld ? 'u' : 'o'}` : '-',
      s.failure ? `F:${s.failure.phase}` : '-',
    ].join('|');
  const abstractKeyOf = (s: CourtConfirmationMachineState): string =>
    keyOf(s).split('|').filter((_, i) => i !== 1).join('|');

  const parkingKind = (s: CourtConfirmationMachineState): string | null => {
    if (s.phase === 'ladder_pending') {
      // Top of the bounded clock universe: no expressible voteDeadline > now
      // remains (L1) — documented artifact, not a machine bug.
      if (s.latestTimestamp === tMax) return 'ladder_pending:clock-universe-exhausted';
      return null;
    }
    if (s.phase === 'ladder_vote_closed') {
      try {
        reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: s.latestTimestamp });
        return null;
      } catch (err) {
        check(err instanceof CourtConfirmationTransitionError, 'parking probe typed error');
        return 'ladder_vote_closed:resolve-refuses';
      }
    }
    if (s.phase === 'fee_settlement') {
      try {
        reduceCourtConfirmationMachine(s, { type: 'finalize', now: s.latestTimestamp });
        return null;
      } catch (err) {
        check(err instanceof CourtConfirmationTransitionError, 'parking probe typed error');
        return 'fee_settlement:finalize-refuses';
      }
    }
    return null;
  };

  return {
    name: spec.name,
    create,
    phaseOf: (s) => s.phase,
    isTerminal: (s) => CONFIRM_TERMINAL.has(s.phase),
    isAcceptingTerminal: (s) => s.phase === 'final' || s.phase === 'expired',
    keyOf,
    abstractKeyOf,
    genEvents,
    isAbort: (e) => (e as { type?: string })?.type === 'abort',
    checkInvariants,
    reduce: (s, e) => reduceCourtConfirmationMachine(s, e as CourtConfirmationMachineEvent),
    ErrorClass: CourtConfirmationTransitionError,
    parkingKind,
    maxStates: 1_500_000,
  };
}

// ─── courtSigningMachine instance (v0.9.3) ──────────────────────────────────
//
// Nonce-commit / close / partial / aggregate enumeration over small signer
// sets, verifying the machine against an independent re-derivation model:
// the frozen signer set must ALWAYS equal the distinct sorted commitment
// ledger (the machine-level counterpart of crypto-audit A-1), partials only
// ever come from that set, and every threshold/equivocation barrier fires as
// a typed error. The F-12 `latestTimestamp` ledger is exercised through the
// same symbolic-time abstraction as the other machines (see L6).

const SIGNING_PHASES = [
  'intent',
  'nonce_commit',
  'commitment_set_final',
  'partial_sign',
  'aggregate',
  'attestation_published',
  'expired',
  'aborted_peer',
  'aborted_coordinator',
  'aborted_network',
] as const;

const SIGNING_TERMINAL = new Set<string>([
  'attestation_published',
  'expired',
  'aborted_peer',
  'aborted_coordinator',
  'aborted_network',
]);

const SIGNING_ACCEPTING = new Set<string>(['attestation_published', 'expired']);

export const SIGNING_SESSION = hex('9');
export const SIGNING_VERDICT = hex('8');
export const SIGNING_OUTCOME = 'yes';
export const SIGNING_SIGNATURE = 'ab'.repeat(64);
export const SIGNING_ATTESTATION_EVENT_ID = hex('7');

/** Real secp256k1 points — the machine validates on-curve membership. */
const signingPoint = (scalarHex: string): string =>
  secp256k1.Point.BASE.multiply(BigInt(`0x${scalarHex}`)).toHex(true);

const OWN_PSIG = (idx: number): string => hex(String(idx)); // first char = the idx digit
const CONFLICT_PSIG = (idx: number): string => hex(`c${idx}`); // first char 'c'

export interface SigningInstanceSpec {
  readonly name: string;
  readonly n: number;
  readonly threshold: number;
  /**
   * Commitment variants: 'own' (the signer's primary nonce points — a repeat
   * is the idempotent re-commit self-loop) always; 'conflict' adds a second,
   * DIFFERENT point pair — nonce equivocation, aborting with peer blame.
   */
  readonly commitmentVariants?: readonly ('own' | 'conflict')[];
  /** Partial variants: 'own' always; 'conflict' adds a DIFFERENT psig — partial equivocation. */
  readonly partialVariants?: readonly ('own' | 'conflict')[];
  /**
   * Reduced clock universe for INLINE (vitest) instances only:
   * [deadline, tMax]. Defaults to the full analysis bounds (10, T_MAX=25).
   * Reduced-clock instances are clearly NAMED as such — their numbers are NOT
   * comparable to the full fixture and they never appear in it.
   */
  readonly inlineClock?: readonly [deadline: number, tMax: number];
}

export function signingAdapter(spec: SigningInstanceSpec): MachineAdapter<CourtSigningMachineState> {
  const roster = Array.from({ length: spec.n }, (_, i) => i + 1);
  const [deadline, tMax] = spec.inlineClock ?? [DEADLINE_A, T_MAX];
  const commitmentVariants = spec.commitmentVariants ?? (['own'] as const);
  const partialVariants = spec.partialVariants ?? (['own'] as const);

  // Distinct real curve points per signer: primary pair (P_i) + conflicting pair (Q_i).
  const binderOf = new Map<string, string>();
  const hiddenOf = new Map<string, string>();
  for (const idx of roster) {
    binderOf.set(`own.${idx}`, signingPoint(`1${idx}`));
    hiddenOf.set(`own.${idx}`, signingPoint(`2${idx}`));
    binderOf.set(`conflict.${idx}`, signingPoint(`3${idx}`));
    hiddenOf.set(`conflict.${idx}`, signingPoint(`4${idx}`));
  }

  const create = (): CourtSigningMachineState =>
    createCourtSigningMachine({
      sessionHash: SIGNING_SESSION,
      verdictHash: SIGNING_VERDICT,
      outcome: SIGNING_OUTCOME,
      participantIndices: roster,
      threshold: spec.threshold,
      attempt: 0,
      deadline,
    });

  const checkInvariants = (s: CourtSigningMachineState): void => {
    check(SIGNING_PHASES.includes(s.phase as never), `P1: unknown signing phase ${s.phase}`);
    check(Number.isSafeInteger(s.latestTimestamp) && s.latestTimestamp >= 0, 'P2: signing clock');
    check(Object.isFrozen(s), 'P2: signing state frozen');
    check(eqArray(s.participantIndices, roster), 'P2: signing roster immutable');
    check(
      s.threshold === spec.threshold && s.deadline === deadline && s.attempt === 0,
      'P2: signing configuration immutable',
    );
    check(
      s.sessionHash === SIGNING_SESSION && s.verdictHash === SIGNING_VERDICT
        && s.outcome === SIGNING_OUTCOME,
      'P2: signing binding fields immutable',
    );
    // Canonical session-binding re-derivation (the machine re-checks this at
    // every reduce entry; assert it independently at every state).
    check(
      s.signingSessionHash === hashCourtSigningSession({
        sessionHash: SIGNING_SESSION,
        verdictHash: SIGNING_VERDICT,
        outcome: SIGNING_OUTCOME,
        participantIndices: roster,
        threshold: spec.threshold,
        attempt: 0,
      }),
      'P2: signingSessionHash matches its canonical re-derivation',
    );

    // Commitment ledger: distinct roster indices, real curve points.
    const committedIdx = new Set<number>();
    for (const c of s.commitments) {
      check(roster.includes(c.idx), 'P2: commitment idx ∈ roster');
      check(
        isValidSecp256k1Point(c.binderPn) && isValidSecp256k1Point(c.hiddenPn),
        'P2: commitment nonces are canonical secp256k1 points',
      );
      check(!committedIdx.has(c.idx), 'P2: no duplicate commitment idx');
      committedIdx.add(c.idx);
    }
    check(s.commitments.length <= roster.length, 'P2: commitment ledger bounded by roster');

    // A-1 (machine level): the frozen signer set is EXACTLY the distinct
    // sorted commitment set — re-derived here independently of the machine.
    if (s.phase === 'intent' || s.phase === 'nonce_commit') {
      check(s.finalizedSignerSet === undefined, 'P2: signer set unfrozen before close_commitments');
    }
    if (s.finalizedSignerSet !== undefined) {
      check(
        eqArray(s.finalizedSignerSet, [...committedIdx].sort((a, b) => a - b)),
        'P2/A-1: finalized signer set == distinct sorted commitment set',
      );
    }

    // Partial ledger — reveal set ⊆ commitment set (A-1), distinct, well-formed.
    const partialIdx = new Set<number>();
    for (const p of s.partials) {
      check(
        s.finalizedSignerSet?.includes(p.idx) === true,
        'P2/A-1: partial signer ∈ the finalized commitment set',
      );
      check(HEX_32.test(p.psig), 'P2: partial psig is 32-byte lowercase hex');
      check(!partialIdx.has(p.idx), 'P2: no duplicate partial idx');
      partialIdx.add(p.idx);
    }
    check(
      s.partials.length === 0
        || !['intent', 'nonce_commit', 'commitment_set_final'].includes(s.phase),
      'P2: partials only from partial_sign onward',
    );
    check(s.phase !== 'partial_sign' || s.partials.length >= 1, 'P2: partial_sign carries ≥ 1 partial');

    // Signature / attestation / failure coherence.
    if (['intent', 'nonce_commit', 'commitment_set_final', 'partial_sign'].includes(s.phase)) {
      check(
        s.signature === undefined && s.attestationEventId === undefined,
        'P2: no signature before aggregation',
      );
    }
    if (s.phase === 'aggregate') check(s.signature !== undefined, 'P2: aggregate phase carries the signature');
    if (s.phase === 'attestation_published') {
      check(
        s.signature !== undefined && s.attestationEventId !== undefined,
        'P2: published carries signature + attestation event id',
      );
      check(s.partials.length >= s.threshold, 'P2: published attempt aggregated ≥ threshold partials');
    }
    check(
      (s.failure !== undefined)
        === ['expired', 'aborted_peer', 'aborted_coordinator', 'aborted_network'].includes(s.phase),
      'P2: signing failure ⟺ expired/aborted',
    );
  };

  const genEvents = (s: CourtSigningMachineState): { events: unknown[]; illegalCount: number } => {
    const latest = s.latestTimestamp;
    const nows = nowCandidates(latest, deadline, deadline, tMax);
    const steps = stepCandidates(latest, tMax);
    const events: unknown[] = [];

    if (s.phase === 'intent') {
      for (const now of nows) events.push({ type: 'start', now });
    }
    if (s.phase === 'nonce_commit') {
      for (const idx of roster) {
        for (const variant of commitmentVariants) {
          for (const now of steps) {
            events.push({
              type: 'accept_commitment',
              idx,
              binderPn: binderOf.get(`${variant}.${idx}`)!,
              hiddenPn: hiddenOf.get(`${variant}.${idx}`)!,
              now,
            });
          }
        }
      }
      for (const now of nows) events.push({ type: 'close_commitments', now });
    }
    if (s.phase === 'commitment_set_final' || s.phase === 'partial_sign') {
      // Legal partials ONLY from the frozen commitment set (A-1); attempts by
      // non-finalized roster members are asserted as typed throws below.
      for (const idx of s.finalizedSignerSet ?? []) {
        for (const variant of partialVariants) {
          const psig = variant === 'own' ? OWN_PSIG(idx) : CONFLICT_PSIG(idx);
          for (const now of steps) events.push({ type: 'accept_partial', idx, psig, now });
        }
      }
      for (const now of nows) events.push({ type: 'aggregate', signature: SIGNING_SIGNATURE, now });
    }
    if (s.phase === 'aggregate') {
      for (const now of nows) {
        events.push({ type: 'publish', attestationEventId: SIGNING_ATTESTATION_EVENT_ID, now });
      }
    }
    for (const now of nows) events.push({ type: 'tick', now });
    events.push(
      { type: 'abort', phase: 'aborted_peer', reason: 'probe-blame', blamedIdx: roster[0] },
      { type: 'abort', phase: 'aborted_coordinator', reason: 'probe' },
    );

    // ── guaranteed-illegal events (typed-error assertion at every state). ──
    const illegal: unknown[] = [
      { type: 'accept_commitment', idx: 0, binderPn: binderOf.get(`own.1`)!, hiddenPn: hiddenOf.get(`own.1`)!, now: latest },
      { type: 'accept_commitment', idx: spec.n + 1, binderPn: binderOf.get(`own.1`)!, hiddenPn: hiddenOf.get(`own.1`)!, now: latest },
      { type: 'accept_commitment', idx: roster[0], binderPn: BAD_HEX, hiddenPn: hiddenOf.get(`own.1`)!, now: latest },
      { type: 'accept_commitment', idx: roster[0], binderPn: binderOf.get(`own.1`)!, hiddenPn: BAD_HEX, now: latest },
      { type: 'accept_partial', idx: 0, psig: OWN_PSIG(1), now: latest },
      { type: 'accept_partial', idx: spec.n + 1, psig: OWN_PSIG(1), now: latest },
      { type: 'accept_partial', idx: roster[0], psig: BAD_HEX, now: latest },
      // 64 hex chars but uppercase — passes the shape regex, fails lowercase HEX_32.
      { type: 'accept_partial', idx: roster[0], psig: OWN_PSIG(1).toUpperCase(), now: latest },
      { type: 'aggregate', signature: 'nothex', now: latest },
      { type: 'aggregate', signature: 'ab'.repeat(63), now: latest },
      { type: 'publish', attestationEventId: BAD_HEX, now: latest },
      { type: 'abort', phase: 'intent', reason: 'not-a-real-failure-phase' },
      { type: 'abort', phase: 'aborted_network', reason: 'bad-blame', blamedIdx: 0 },
      { type: 'tick' }, // missing clock
      { type: 'tick', now: -1 },
      { type: 'tick', now: 1.5 },
      { type: 'tick', now: '5' },
      { type: 'galaxy_brain', now: latest },
      null,
      42,
    ];
    if (s.phase !== 'intent') illegal.push({ type: 'start', now: latest });
    if (s.phase !== 'nonce_commit') illegal.push({ type: 'close_commitments', now: latest });
    if (s.finalizedSignerSet !== undefined) {
      const outside = roster.find((i) => !s.finalizedSignerSet!.includes(i));
      if (outside !== undefined) {
        // THE A-1 GUARD: a partial from a committed-but-not-finalized signer.
        illegal.push({ type: 'accept_partial', idx: outside, psig: OWN_PSIG(outside), now: latest });
      }
    }
    if (latest >= 1) illegal.push({ type: 'tick', now: latest - 1 });
    if (SIGNING_TERMINAL.has(s.phase)) {
      illegal.push({ type: 'abort', phase: 'aborted_peer', reason: 'too-late' });
    }
    events.push(...illegal);
    return { events, illegalCount: illegal.length };
  };

  const keyOf = (s: CourtSigningMachineState): string =>
    [
      s.phase,
      s.latestTimestamp,
      s.commitments.map((c) => `${c.idx}${c.binderPn === binderOf.get(`own.${c.idx}`) ? 'o' : 'x'}`).join(','),
      s.finalizedSignerSet ? s.finalizedSignerSet.join('.') : '-',
      s.partials.map((p) => `${p.idx}${p.psig[0] === String(p.idx)[0] ? 'o' : 'x'}`).join(','),
      s.signature ? (s.signature === SIGNING_SIGNATURE ? 'sig' : 'sig?') : '-',
      s.attestationEventId ? 'att' : '-',
      s.failure ? `F:${s.failure.phase}${s.failure.blamedIdx ?? ''}` : '-',
    ].join('|');
  const abstractKeyOf = (s: CourtSigningMachineState): string =>
    keyOf(s).split('|').filter((_, i) => i !== 1).join('|');

  // Every non-terminal state can reach the accepting `expired` terminal via a
  // tick at now ≥ deadline (always expressible: the clock candidates include
  // the deadline and the current clock) — so the signing machine has NO
  // parking states; the explorer verifies that biconditional.
  const parkingKind = (): string | null => null;

  return {
    name: spec.name,
    create,
    phaseOf: (s) => s.phase,
    isTerminal: (s) => SIGNING_TERMINAL.has(s.phase),
    isAcceptingTerminal: (s) => SIGNING_ACCEPTING.has(s.phase),
    keyOf,
    abstractKeyOf,
    genEvents,
    isAbort: (e) => (e as { type?: string })?.type === 'abort',
    checkInvariants,
    reduce: (s, e) => reduceCourtSigningMachine(s, e as CourtSigningMachineEvent),
    ErrorClass: CourtSigningTransitionError,
    parkingKind,
    maxStates: 1_500_000,
  };
}

// ─── the exhaustive exploration suites ──────────────────────────────────────

export const VOTE_INSTANCES_FULL: readonly VoteInstanceSpec[] = [
  { name: 'vote n=1 k=2', n: 1, outcomes: ['yes', 'no'] },
  { name: 'vote n=2 k=2', n: 2, outcomes: ['yes', 'no'] },
  { name: 'vote n=3 k=2', n: 3, outcomes: ['yes', 'no'] },
  { name: 'vote n=4 k=2', n: 4, outcomes: ['yes', 'no'] },
  { name: 'vote n=2 k=3', n: 2, outcomes: ['a', 'b', 'c'] },
];

/** Inline (vitest) vote instances: everything except the multi-minute n=4 headline. */
export const VOTE_INSTANCES_INLINE: readonly VoteInstanceSpec[] =
  VOTE_INSTANCES_FULL.filter((s) => s.n <= 3);

export const SIGNING_INSTANCES_FULL: readonly SigningInstanceSpec[] = [
  // minimal quorum: every single signer can close + aggregate
  { name: 'signing n=2 t=1 [clock 10/25]', n: 2, threshold: 1 },
  // the canonical 2-of-3 committee: partial subsets over a frozen signer set
  { name: 'signing n=3 t=2 [clock 10/25]', n: 3, threshold: 2 },
  // equivocation paths (crypto-audit A-1 class), isolated per ledger — the
  // combined both-ledger instance explodes (per-signer own/conflict variants
  // multiply across the commitment AND partial ledgers × the abort-terminal
  // clock universe). The signing machine's per-reduce on-curve re-validation
  // of every stored commitment makes its sweep ~30× costlier per event
  // application than the vote machine (measured ≈ 1.2K applications/s vs
  // ≈ 45K/s), so n = 4 and full-clock equivocation sweeps do not fit the
  // runtime budget (same documented trade-off as confirmation n = 4, L3/L7).
  { name: 'signing n=3 t=2 commitment-equivocation [clock 6/12]', n: 3, threshold: 2, commitmentVariants: ['own', 'conflict'] },
  { name: 'signing n=3 t=2 partial-equivocation [clock 6/12]', n: 3, threshold: 2, partialVariants: ['own', 'conflict'] },
];

/** Inline (vitest) signing instances: reduced clock, n ≤ 3, no equivocation variants. */
export const SIGNING_INSTANCES_INLINE: readonly SigningInstanceSpec[] =
  SIGNING_INSTANCES_FULL
    .filter((s) => s.n <= 3 && !s.name.includes('equivocation'))
    .map((s) => ({
      ...s,
      name: s.name.replace('[clock 10/25]', '[inline clock 4/8]'),
      inlineClock: [4, 8] as const,
    }));

export const CONFIRM_INSTANCES_FULL: readonly ConfirmInstanceSpec[] = [
  // multi-challenger ledger + full quorum (single round)
  {
    name: 'confirm n=3 q=3 r=1 challengers=all [clock 6/12/14]',
    n: 3,
    quorum: 3,
    maxLadderRounds: 1,
    challengers: [1, 2, 3],
    inlineClock: [6, 12, 14],
  },
  // duplicate confirmation + mass-vote event ids vs the finalize/resolve barriers (L5)
  {
    name: 'confirm n=3 q=1 r=1 dup-event-ids [clock 6/12/14]',
    n: 3,
    quorum: 1,
    maxLadderRounds: 1,
    challengers: [1],
    confirmEventIdVariants: ['own', 'shared'],
    massVoteEventIdVariants: ['own', 'shared'],
    inlineClock: [6, 12, 14],
  },
  // escalation ladder: round_resolved → escalate/concede, flip-flop clawbacks
  {
    name: 'confirm n=3 q=1 r=2 [clock 6/12/14]',
    n: 3,
    quorum: 1,
    maxLadderRounds: 2,
    challengers: [1],
    inlineClock: [6, 12, 14],
  },
  // explicit (identity) roundRoster expansion on open_ladder_round (L4)
  {
    name: 'confirm n=3 q=1 r=1 roundRoster [clock 6/12/14]',
    n: 3,
    quorum: 1,
    maxLadderRounds: 1,
    challengers: [1],
    roundRosterVariant: true,
    inlineClock: [6, 12, 14],
  },
  // NOTE: n=3 is the publishable exhaustive confirmation instance, explored
  // at a reduced but boundary-complete clock universe (deadlines 6/12, clock
  // ≤ 14 — the vote machine carries the full 10/20/25 analysis). The
  // confirmation machine's ledger combinatorics (quorum × challengers ×
  // ladder rounds) dominate its state space, so neither a full-clock n=3
  // sweep nor any n=4 confirmation sweep fits the documented runtime budget
  // (see header, run-mode split / L1 / L3).
];

// ─── run-mode instance sets ─────────────────────────────────────────────────
//
// FULL (below) runs ONLY via `npx tsx scripts/model-check.mjs` — it contains
// the multi-million-state headline instance (vote n=4, ~55M event
// applications, several minutes). NEVER import the FULL vote set into the
// vitest suite: `npm test` must stay bounded (measured ≈ 9 min wall for the
// modelChecking file) and CI would die.
// INLINE (filtered/reduced) is what `__tests__/modelChecking.test.ts` runs.

/** Properties asserted at every reachable state of every instance (mirrored into the summary fixture + PR body). */
export const PROPERTIES_CHECKED: readonly string[] = [
  'P1 phase legality — phase ∈ the machine\'s declared phase set, at every reachable state',
  'P2 data invariants — ledger ⊆ roster with unique indices, reveals ⊆ commits, ballot closure, real SHA-256 commit-reveal / canonical confirmation-hash / signing-session-hash re-derivation, real secp256k1 nonce points, signer-set freeze == distinct commitment set (A-1), partials ⊆ finalized signer set (A-1), verdict⇔phase coherence, failure⇔expired/aborted, configuration immutability, deep-frozen states, monotonic clock on every edge, tally re-derivation at terminal phases',
  'P3 no dead ends — biconditional: a non-terminal state can reach a non-aborted terminal IFF it is not one of the machine\'s own probe-derived parking states',
  'P4 termination — the progress graph (legal, state-changing, non-abort edges) is acyclic (Kahn); idempotent re-applications are counted self-loops, not cycles',
  'P5 determinism — ≥ 200 sampled paths per instance replayed from creation, twice, byte-identical states',
  'typed-error discipline — every illegal event application throws the machine\'s OWN error class (CourtVoteTransitionError / CourtConfirmationTransitionError / CourtSigningTransitionError); any raw TypeError/RangeError fails the instance',
];

/** Cheap instances the vitest suite re-explores to cross-check the committed fixture (guards staleness). */
export const FIXTURE_CROSS_CHECK_NAMES: readonly string[] = [
  'vote n=1 k=2',
  'vote n=2 k=2',
  'signing n=2 t=1 [clock 10/25]',
];

/** Instances skipped by the script's --fast mode (the multi-minute headline sweep). */
export const FAST_SKIP_NAMES: readonly string[] = ['vote n=4 k=2'];

export const FULL_INSTANCE_NAMES: readonly string[] = [
  ...VOTE_INSTANCES_FULL.map((s) => s.name),
  ...CONFIRM_INSTANCES_FULL.map((s) => s.name),
  ...SIGNING_INSTANCES_FULL.map((s) => s.name),
];

/** Instance names the committed fixture must contain for the given script mode. */
export function requiredFixtureInstanceNames(mode: 'full' | 'fast'): readonly string[] {
  return mode === 'fast'
    ? FULL_INSTANCE_NAMES.filter((n) => !FAST_SKIP_NAMES.includes(n))
    : FULL_INSTANCE_NAMES;
}
