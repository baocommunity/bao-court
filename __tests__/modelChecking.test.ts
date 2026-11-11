// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Exhaustive finite-state-space model checking of the three BAO Court phase
 * machines (v0.9.3) — the VITEST side: REDUCED instances + committed-fixture
 * assertions. The explorer itself lives in `__tests__/modelCheckingCore.ts`
 * (framework-free; its header carries the full methodology, abstraction
 * limits, and findings F1–F6).
 *
 * ─── RUN-MODE SPLIT (read this before touching the instance lists) ─────────
 *
 *   1. `npm test` (this file) runs a REDUCED inline sweep — vote n ≤ 3,
 *      reduced-clock confirmation instances, and reduced-clock signing
 *      instances. MEASURED budget ≈ 9 minutes wall for this file on the
 *      16-core reference dev machine (the reduced-clock confirmation
 *      instances dominate; every per-test timeout is 600 s). NEVER move the
 *      multi-million-state instances into this suite: CI would die.
 *
 *   2. The FULL exhaustive sweep (the vote n=4 headline ≈ 1.27M concrete
 *      states / 54.7M event applications, the publishable confirmation
 *      instances at their reduced clock, and the full-clock signing
 *      instances; several minutes of wall time) runs ONLY via the standalone
 *      script:
 *
 *          npx tsx scripts/model-check.mjs           # full sweep
 *          npx tsx scripts/model-check.mjs --fast    # skips vote n=4 (CI-friendly)
 *
 *      The script (re)generates `__fixtures__/model-check-summary.json` —
 *      the committed per-instance state-space summary. This suite asserts
 *      that fixture: presence, all-green invariants (zero raw throws, zero
 *      invariant violations, acyclic progress graphs) for every required
 *      instance, and — against staleness — cross-checks two cheap instances
 *      by re-exploring them HERE and comparing the numbers exactly. If an
 *      instance set or a machine changes, re-run the script and commit the
 *      refreshed fixture in the same change.
 */

import { describe, expect, it } from 'vitest';

import {
  BOND_PROOF,
  BOND_TX,
  DEADLINE_A,
  DEADLINE_B,
  FEE_EVENT,
  FIXTURE_CROSS_CHECK_NAMES,
  MANUAL_REASON,
  PROPERTIES_CHECKED,
  SIGNING_SESSION,
  SIGNING_SIGNATURE,
  SIGNING_VERDICT,
  VOTE_SALT,
  VOTE_INSTANCES_FULL,
  VOTE_INSTANCES_INLINE,
  CONFIRM_INSTANCES_FULL,
  SIGNING_INSTANCES_FULL,
  SIGNING_INSTANCES_INLINE,
  confirmAdapter,
  exploreMachine,
  hex,
  printStats,
  requiredFixtureInstanceNames,
  signingAdapter,
  voteAdapter,
  type ConfirmInstanceSpec,
  type SigningInstanceSpec,
  type VoteInstanceSpec,
} from './modelCheckingCore';
import { loadModelCheckSummary } from './helpers/fixtures';
import {
  CourtVoteTransitionError,
  createCourtVoteMachine,
  hashCourtVoteCommit,
  reduceCourtVoteMachine,
  type CourtVoteMachineState,
} from '../courtVoteMachine';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import {
  CourtSigningTransitionError,
  createCourtSigningMachine,
  reduceCourtSigningMachine,
  type CourtSigningMachineState,
} from '../courtSigningMachine';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// ─── the reduced inline exhaustive suites (npm-test budget) ─────────────────

/** Confirmation instances for the inline run. The machine refuses n < 3 at
 * creation (r3-6), so n=3 is the floor; the clock universe is REDUCED
 * (inlineClock) to keep the inline sweep inside the npm-test budget — the
 * full-clock confirmation instances run in the standalone script only.
 * Reduced-clock numbers are NOT in the fixture (clearly named; not
 * comparable). */
const CONFIRM_INSTANCES_INLINE: readonly ConfirmInstanceSpec[] = [
  {
    name: 'confirm n=3 q=3 r=1 challengers=all [inline clock 4/8/10]',
    n: 3,
    quorum: 3,
    maxLadderRounds: 1,
    challengers: [1, 2, 3],
    inlineClock: [4, 8, 10],
  },
  {
    name: 'confirm n=3 q=1 r=2 [inline clock 4/8/10]',
    n: 3,
    quorum: 1,
    maxLadderRounds: 2,
    challengers: [1],
    inlineClock: [4, 8, 10],
  },
];

describe('exhaustive model checking — courtVoteMachine (reduced inline instances)', () => {
  for (const spec of VOTE_INSTANCES_INLINE) {
    it(
      `explores every reachable state: ${spec.name}`,
      () => {
        const stats = exploreMachine(voteAdapter(spec));
        printStats(stats);
        expect(stats.rawThrows).toBe(0);
        expect(stats.states).toBeGreaterThan(0);
      },
      600_000,
    );
  }
});

describe('exhaustive model checking — courtConfirmationMachine (reduced inline instances)', () => {
  for (const spec of CONFIRM_INSTANCES_INLINE) {
    it(
      `explores every reachable state: ${spec.name}`,
      () => {
        const stats = exploreMachine(confirmAdapter(spec));
        printStats(stats);
        expect(stats.rawThrows).toBe(0);
        expect(stats.states).toBeGreaterThan(0);
      },
      600_000,
    );
  }
});

/** Signing instances for the inline run: reduced clock [deadline 4, tMax 8].
 * The signing machine's ledger combinatorics are lighter than the
 * confirmation machine's (no ladder), but the reduced clock keeps the inline
 * sweep comfortably inside the npm-test budget; the full-clock instances run
 * in the standalone script only. Reduced-clock numbers are NOT in the
 * fixture (clearly named; not comparable). */

describe('exhaustive model checking — courtSigningMachine (reduced inline instances)', () => {
  for (const spec of SIGNING_INSTANCES_INLINE) {
    it(
      `explores every reachable state: ${spec.name}`,
      () => {
        const stats = exploreMachine(signingAdapter(spec));
        printStats(stats);
        expect(stats.rawThrows).toBe(0);
        expect(stats.states).toBeGreaterThan(0);
      },
      600_000,
    );
  }
});

// ─── committed full-sweep fixture (generated by scripts/model-check.mjs) ────
// Reader + types imported from helpers/fixtures (loadModelCheckSummary).


/** Deterministic per-instance numbers (wallMs is timing, not state space). */
const CROSS_CHECK_KEYS = [
  'states',
  'abstractStates',
  'progressEdges',
  'selfLoops',
  'applications',
  'typedThrows',
  'rawThrows',
  'illegalChecks',
  'terminalStates',
  'parkingStates',
  'tallyReachableStates',
  'determinismPathsReplayed',
] as const;

describe('model checking — committed full-sweep fixture (__fixtures__/model-check-summary.json)', () => {
  it('exists and covers every required instance, all green', () => {
    const fixture = loadModelCheckSummary();
    expect(['full', 'fast']).toContain(fixture.mode);
    expect(fixture.propertiesChecked).toEqual(PROPERTIES_CHECKED);
    const recorded = new Map(fixture.instances.map((i) => [i.name, i]));
    for (const name of requiredFixtureInstanceNames(fixture.mode)) {
      const instance = recorded.get(name);
      expect(instance, `fixture is missing instance ${name} — re-run scripts/model-check.mjs`).toBeDefined();
      expect(instance!.states).toBeGreaterThan(0);
      expect(instance!.rawThrows).toBe(0);
    }
    expect(fixture.totals.rawThrows).toBe(0);
    expect(fixture.totals.instances).toBe(fixture.instances.length);
  });

  it('vacuity guard (round-16 review, finding A-2): instance state counts are pairwise distinct', () => {
    // Finding F7 (PR #58) showed a variant instance whose fabricated
    // conflicts collapsed onto its base — identical state spaces, so the
    // variant exercised nothing it claimed while the suite stayed green.
    // This guard systematizes that lesson: a variant instance whose state
    // count equals another instance's is vacuous by the F7 criterion and
    // must be re-tuned (or its distinctness argument documented HERE before
    // this assertion is relaxed).
    const fixture = loadModelCheckSummary();
    const byStates = new Map<number, string[]>();
    for (const instance of fixture.instances) {
      const names = byStates.get(instance.states) ?? [];
      names.push(instance.name);
      byStates.set(instance.states, names);
    }
    const collisions = [...byStates.entries()].filter(([, names]) => names.length > 1);
    expect(
      collisions,
      `F7 vacuity: instances sharing a state space are not exercising what they claim — ` +
        `re-tune or justify: ${collisions.map(([s, names]) => `${s}: ${names.join(' / ')}`).join('; ')}`,
    ).toEqual([]);
  });

  it(
    'cross-check: re-exploring the cheap instances reproduces the fixture numbers exactly',
    () => {
      const fixture = loadModelCheckSummary();
      for (const name of FIXTURE_CROSS_CHECK_NAMES) {
        const spec: VoteInstanceSpec | ConfirmInstanceSpec | SigningInstanceSpec | undefined =
          VOTE_INSTANCES_FULL.find((s) => s.name === name)
          ?? CONFIRM_INSTANCES_FULL.find((s) => s.name === name)
          ?? SIGNING_INSTANCES_FULL.find((s) => s.name === name);
        expect(spec, `cross-check instance ${name} vanished from the core spec lists`).toBeDefined();
        const recorded = fixture.instances.find((i) => i.name === name);
        expect(recorded, `fixture is missing cross-check instance ${name}`).toBeDefined();
        const stats = 'quorum' in spec!
          ? exploreMachine(confirmAdapter(spec as ConfirmInstanceSpec))
          : 'threshold' in spec!
            ? exploreMachine(signingAdapter(spec as SigningInstanceSpec))
            : exploreMachine(voteAdapter(spec as VoteInstanceSpec));
        for (const key of CROSS_CHECK_KEYS) {
          expect(
            stats[key],
            `fixture stale for ${name}.${key}: committed=${recorded![key]} fresh=${stats[key]} — re-run scripts/model-check.mjs`,
          ).toBe(recorded![key]);
        }
      }
    },
    120_000,
  );
});

// ─── creation-space rejection: typed errors at the constructor boundary ─────

describe('model checking — creation space rejects malformed instances with typed errors', () => {
  it('vote machine creation rejections are CourtVoteTransitionError', () => {
    const base = {
      sessionHash: hex('1'),
      participantIndices: [1, 2, 3],
      allowedOutcomes: ['yes', 'no'],
      commitDeadline: DEADLINE_A,
      revealDeadline: DEADLINE_B,
    };
    const bad: Record<string, unknown>[] = [
      { ...base, sessionHash: 'nothex' },
      { ...base, sessionHash: hex('a').toUpperCase() },
      { ...base, participantIndices: [] },
      { ...base, participantIndices: [2, 1] },
      { ...base, participantIndices: [1, 1] },
      { ...base, participantIndices: [0, 1] },
      { ...base, participantIndices: [1, 2.5] },
      { ...base, allowedOutcomes: ['only'] },
      { ...base, allowedOutcomes: [] },
      { ...base, allowedOutcomes: ['yes', 'yes'] },
      { ...base, allowedOutcomes: ['yes', ''] },
      { ...base, commitDeadline: 0 },
      { ...base, commitDeadline: 1.5 },
      { ...base, revealDeadline: DEADLINE_A },
      { ...base, revealDeadline: DEADLINE_A - 1 },
    ];
    for (const params of bad) {
      expect(() => createCourtVoteMachine(params as never)).toThrow(CourtVoteTransitionError);
    }
  });

  it('confirmation machine creation rejections are CourtConfirmationTransitionError', () => {
    const base = {
      sessionHash: hex('2'),
      proposalHash: hex('3'),
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [1, 2, 3],
      confirmQuorum: 1,
      confirmDeadline: DEADLINE_A,
      challengeDeadline: DEADLINE_B,
      maxLadderRounds: 2,
    };
    const bad: Record<string, unknown>[] = [
      { ...base, participantIndices: [1] }, // r3-6: roster < 3 refused at creation
      { ...base, participantIndices: [1, 2] },
      { ...base, participantIndices: [2, 1, 3] },
      { ...base, proposedOutcome: 'MAYBE' },
      { ...base, confirmQuorum: 0 },
      { ...base, confirmQuorum: 4 },
      { ...base, confirmQuorum: 1.5 },
      { ...base, challengeDeadline: DEADLINE_A },
      { ...base, maxLadderRounds: 0 },
      { ...base, maxLadderRounds: 6 },
      { ...base, maxLadderRounds: 1.5 },
      { ...base, proposalHash: 'nothex' },
      { ...base, allowedOutcomes: ['YES'] },
    ];
    for (const params of bad) {
      expect(() => createCourtConfirmationMachine(params as never)).toThrow(CourtConfirmationTransitionError);
    }
  });

  it('signing machine creation rejections are CourtSigningTransitionError', () => {
    const base = {
      sessionHash: hex('9'),
      verdictHash: hex('8'),
      outcome: 'yes',
      participantIndices: [1, 2, 3],
      threshold: 2,
      attempt: 0,
      deadline: DEADLINE_A,
    };
    const bad: Record<string, unknown>[] = [
      { ...base, sessionHash: 'nothex' },
      { ...base, sessionHash: hex('a').toUpperCase() }, // letters so toUpperCase actually changes the string
      { ...base, verdictHash: 'nothex' },
      { ...base, outcome: '' },
      { ...base, participantIndices: [] },
      { ...base, participantIndices: [2, 1] },
      { ...base, participantIndices: [1, 1] },
      { ...base, participantIndices: [1, 2.5] },
      { ...base, threshold: 0 },
      { ...base, threshold: 4 }, // > signer count
      { ...base, threshold: 1.5 },
      { ...base, attempt: -1 },
      { ...base, attempt: 0.5 },
      { ...base, deadline: 0 },
      { ...base, deadline: 1.5 },
    ];
    for (const params of bad) {
      expect(() => createCourtSigningMachine(params as never)).toThrow(CourtSigningTransitionError);
    }
  });

  it('boundary instances are accepted (n=1 vote, n=3 confirmation, quorum=roster, signing 1-of-1)', () => {
    expect(
      createCourtVoteMachine({
        sessionHash: hex('1'),
        participantIndices: [1],
        allowedOutcomes: ['yes', 'no'],
        commitDeadline: DEADLINE_A,
        revealDeadline: DEADLINE_B,
      }).phase,
    ).toBe('commit_open');
    expect(
      createCourtConfirmationMachine({
        sessionHash: hex('2'),
        proposalHash: hex('3'),
        proposedOutcome: 'YES',
        allowedOutcomes: ['YES', 'NO'],
        participantIndices: [1, 2, 3],
        confirmQuorum: 3,
        confirmDeadline: DEADLINE_A,
        challengeDeadline: DEADLINE_B,
      }).phase,
    ).toBe('confirm_open');
    expect(
      createCourtSigningMachine({
        sessionHash: hex('9'),
        verdictHash: hex('8'),
        outcome: 'yes',
        participantIndices: [1],
        threshold: 1,
        attempt: 0,
        deadline: DEADLINE_A,
      }).phase,
    ).toBe('intent');
  });
});

// ── targeted determinism: identical event sequences, identical states ──

describe('model checking — determinism on fixed sequences', () => {
  it('replaying a fixed legal vote sequence twice yields identical states', () => {
    const adapter = voteAdapter({ name: 'vote determinism probe', n: 3, outcomes: ['yes', 'no'] });
    const sessionHash = hex('1');
    const run = (): CourtVoteMachineState => {
      let s = adapter.create();
      const commit = (idx: number, outcome: string): void => {
        s = reduceCourtVoteMachine(s, {
          type: 'accept_commit',
          idx,
          commitHash: hashCourtVoteCommit({ sessionHash, outcome, salt: VOTE_SALT }),
          eventId: hex(String(idx)),
          now: 5,
        });
      };
      commit(1, 'yes');
      commit(2, 'no');
      commit(3, 'yes');
      s = reduceCourtVoteMachine(s, { type: 'close_commits', now: DEADLINE_A });
      s = reduceCourtVoteMachine(s, { type: 'open_reveals', now: DEADLINE_A + 1 });
      s = reduceCourtVoteMachine(s, { type: 'accept_reveal', idx: 1, outcome: 'yes', salt: VOTE_SALT, eventId: hex('1'), now: 15 });
      s = reduceCourtVoteMachine(s, { type: 'accept_reveal', idx: 2, outcome: 'no', salt: VOTE_SALT, eventId: hex('2'), now: 15 });
      s = reduceCourtVoteMachine(s, { type: 'accept_reveal', idx: 3, outcome: 'yes', salt: VOTE_SALT, eventId: hex('3'), now: 16 });
      s = reduceCourtVoteMachine(s, { type: 'close_reveals', now: DEADLINE_B });
      return reduceCourtVoteMachine(s, { type: 'finalize_tally', now: DEADLINE_B + 1 });
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.phase).toBe('tally_final');
    expect(a.verdict?.outcome).toBe('yes'); // 2–1 tie-break-free majority
  });

  it('replaying a fixed legal confirmation ladder twice yields identical states', () => {
    const sessionHash = hex('2');
    const proposalHash = hex('3');
    const run = (): CourtConfirmationMachineState => {
      let s = createCourtConfirmationMachine({
        sessionHash,
        proposalHash,
        proposedOutcome: 'YES',
        allowedOutcomes: ['YES', 'NO'],
        participantIndices: [1, 2, 3],
        confirmQuorum: 1,
        confirmDeadline: DEADLINE_A,
        challengeDeadline: DEADLINE_B,
        maxLadderRounds: 2,
      });
      s = reduceCourtConfirmationMachine(s, { type: 'accept_confirmation', idx: 1, confirmHash: hashCourtConfirmation({ sessionHash, proposalHash, idx: 1 }), eventId: hex('1'), now: 5 });
      s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: DEADLINE_A });
      s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: DEADLINE_A + 1 });
      s = reduceCourtConfirmationMachine(s, { type: 'accept_challenge', idx: 1, bondTxid: BOND_TX, bondProofHash: BOND_PROOF, eventId: hex('1'), now: 15 });
      s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: DEADLINE_B });
      s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 22, now: 21 });
      s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 1, outcome: 'NO', eventId: hex('1'), now: 21 });
      s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 2, outcome: 'NO', eventId: hex('2'), now: 21 });
      s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx: 3, outcome: 'YES', eventId: hex('3'), now: 21 });
      s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 22 });
      s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 22 });
      expect(s.phase).toBe('round_resolved'); // round 1 of 2 parks for the host
      s = reduceCourtConfirmationMachine(s, {
        type: 'escalate',
        authority: 'challenger',
        challengerIdx: 1,
        challengerPubkey: BOND_PROOF,
        requestHash: BOND_TX,
        bondProofHash: BOND_PROOF,
        roundIndex: 2,
        now: 22,
      });
      s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 2, voteDeadline: 24, now: 23 });
      for (const idx of [1, 2, 3]) {
        s = reduceCourtConfirmationMachine(s, { type: 'accept_mass_vote', idx, outcome: 'YES', eventId: hex(String(idx)), now: 23 });
      }
      s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 24 });
      s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 24 });
      s = reduceCourtConfirmationMachine(s, { type: 'record_fee', feeEventId: FEE_EVENT, now: 25 });
      return reduceCourtConfirmationMachine(s, { type: 'finalize', now: 25 });
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.phase).toBe('final');
    expect(a.verdict?.outcome).toBe('YES');
    // Round 1 said NO (flip) → round 1's majority voters are flagged.
    expect(a.clawbackFlags.some((f) => f.reason === 'round_flip' && f.round === 1)).toBe(true);
    expect(a.verdict?.upheld).toBe(true);
  });

  it('replaying a fixed legal signing round twice yields identical states', () => {
    const run = (): CourtSigningMachineState => {
      let s = createCourtSigningMachine({
        sessionHash: SIGNING_SESSION,
        verdictHash: SIGNING_VERDICT,
        outcome: 'yes',
        participantIndices: [1, 2, 3],
        threshold: 2,
        attempt: 0,
        deadline: DEADLINE_A,
      });
      s = reduceCourtSigningMachine(s, { type: 'start', now: 1 });
      for (const idx of [1, 2]) {
        s = reduceCourtSigningMachine(s, {
          type: 'accept_commitment',
          idx,
          binderPn: secp256k1.Point.BASE.multiply(BigInt(`0x1${idx}`)).toHex(true),
          hiddenPn: secp256k1.Point.BASE.multiply(BigInt(`0x2${idx}`)).toHex(true),
          now: 2,
        });
      }
      s = reduceCourtSigningMachine(s, { type: 'close_commitments', now: 3 });
      expect(s.phase).toBe('commitment_set_final');
      expect(s.finalizedSignerSet).toEqual([1, 2]); // A-1: exactly the committed set
      for (const idx of [2, 1]) {
        s = reduceCourtSigningMachine(s, { type: 'accept_partial', idx, psig: hex(String(idx)), now: 4 });
      }
      s = reduceCourtSigningMachine(s, { type: 'aggregate', signature: SIGNING_SIGNATURE, now: 5 });
      return reduceCourtSigningMachine(s, { type: 'publish', attestationEventId: hex('4'), now: 6 });
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.phase).toBe('attestation_published');
    expect(a.partials.map((p) => p.idx)).toEqual([2, 1]); // arrival order preserved
  });

  it('A-1 guard: partials from outside the frozen commitment set are refused with typed errors', () => {
    let s = createCourtSigningMachine({
      sessionHash: SIGNING_SESSION,
      verdictHash: SIGNING_VERDICT,
      outcome: 'yes',
      participantIndices: [1, 2, 3],
      threshold: 2,
      attempt: 0,
      deadline: DEADLINE_A,
    });
    s = reduceCourtSigningMachine(s, { type: 'start', now: 1 });
    for (const idx of [1, 2]) {
      s = reduceCourtSigningMachine(s, {
        type: 'accept_commitment',
        idx,
        binderPn: secp256k1.Point.BASE.multiply(BigInt(`0x1${idx}`)).toHex(true),
        hiddenPn: secp256k1.Point.BASE.multiply(BigInt(`0x2${idx}`)).toHex(true),
        now: 2,
      });
    }
    s = reduceCourtSigningMachine(s, { type: 'close_commitments', now: 3 });
    // signer 3 committed NOTHING — a partial from 3 must be refused (A-1)
    expect(() =>
      reduceCourtSigningMachine(s, { type: 'accept_partial', idx: 3, psig: hex('3'), now: 4 }),
    ).toThrow(CourtSigningTransitionError);
    // and a below-threshold aggregate must be refused
    s = reduceCourtSigningMachine(s, { type: 'accept_partial', idx: 1, psig: hex('1'), now: 4 });
    expect(() =>
      reduceCourtSigningMachine(s, { type: 'aggregate', signature: SIGNING_SIGNATURE, now: 5 }),
    ).toThrow(CourtSigningTransitionError);
  });
});
