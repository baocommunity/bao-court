// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * REVIEW ROUND 8 — the escalation transport (v0.14.0) and the round-7 finality
 * barrier, attacked.
 *
 * One describe() per target, and every attack is a test:
 *
 *   T1  the wire codec — canonicality (caseId encoding, duplicate keys, the
 *       `'-'` sentinel, junk, the `concession` flag, getter double-fetch);
 *   T2  the wire→reducer mapping — the three wire claims the reducer cannot
 *       check (challengerPubkey, caseId, round) and the host binding that now
 *       closes them; `now` is the host's clock, not the request's;
 *   T3  the round-7 finality barrier — every path to `finalize`, a forged vote
 *       ledger on each, a manufactured-but-consistent history, and the
 *       `resolve_round` history/ladder consistency check (r8-6);
 *   T4  the four r41-1 closures — pinned as guards (their red-on-pre-fix run is
 *       recorded in `docs/REVIEW_ROUND_8.md`: 4 red on `1b33b2f`).
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ESCALATION_CASE_ID_BYTES,
  buildCourtEscalationRequest,
  courtEscalationRequestPreimage,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
  type CourtEscalationBinding,
  type CourtEscalationRequest,
} from '../courtEscalationRequest';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { hexId } from './helpers/ids';

/** Hex-only 32-byte event id from a label (labels carry letters, ids cannot). */
const hid = (label: string): string =>
  label.split('').map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('').padStart(64, '0').slice(-64);

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;
const BOND_TXID = hexId('d');
const MEMBERSHIP_BOND = hexId('e');
const CHALLENGER_PUBKEY = hexId('7');
const EVENT_ID = hexId('8');
const CASE_ID = 'court:market-r48-wire:1';
const ROUND_BOND = hid('a2');
const OTHER_PUBKEY = hexId('9');


/** The host half of the binding (r8-2): the routed case id + the NIP-98 pubkey. */
const BINDING: CourtEscalationBinding = {
  caseId: CASE_ID,
  authenticatedPubkey: CHALLENGER_PUBKEY,
};

function request(overrides: Partial<CourtEscalationRequest> = {}): CourtEscalationRequest {
  return buildCourtEscalationRequest({
    caseId: CASE_ID,
    round: 1,
    challengerPubkey: CHALLENGER_PUBKEY,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: ROUND_BOND,
    eventId: EVENT_ID,
    signedAtSec: 1_790_000_000,
    ...overrides,
  });
}

function wireOf(req: CourtEscalationRequest): Record<string, unknown> {
  return JSON.parse(serializeCourtEscalationRequest(req)) as Record<string, unknown>;
}

/** A challenged case parked at `round_resolved` after round 1 (juror 2 bonded). */
/**
 * A challenged case parked at `round_resolved` after round 1 (juror 2 bonded).
 * Default `maxLadderRounds` is 3 so round 1 parks — a 1-round case settles
 * directly from `resolve_round`.
 */
function resolvedRoundOne(opts: { requireRoundBond?: boolean; maxLadderRounds?: number } = {}): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: opts.maxLadderRounds ?? 3,
    ...(opts.requireRoundBond === undefined ? {} : { requireRoundBond: opts.requireRoundBond }),
  });
  s = confirmAll(s);
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 1000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 1100 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    eventId: hid('c2'),
    now: 1500,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  return voteRound(s, 1, 'NO', 2100);
}

function confirmAll(s: CourtConfirmationMachineState): CourtConfirmationMachineState {
  let next = s;
  for (const idx of ROSTER) {
    next = reduceCourtConfirmationMachine(next, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: hid(`c${idx}`),
      now: 100 + idx,
    });
  }
  return next;
}

/** Open, vote and resolve one ladder round (every juror votes `outcome`). */
function voteRound(
  s: CourtConfirmationMachineState,
  round: number,
  outcome: string,
  base: number,
): CourtConfirmationMachineState {
  let next = reduceCourtConfirmationMachine(s, {
    type: 'open_ladder_round', round, voteDeadline: base + 1000, now: base + 50,
  });
  for (const idx of ROSTER) {
    next = reduceCourtConfirmationMachine(next, {
      type: 'accept_mass_vote', idx, outcome, eventId: hid(`v${round}${idx}`), now: base + 100 + idx,
    });
  }
  next = reduceCourtConfirmationMachine(next, { type: 'close_ladder_round', now: base + 1000 });
  return reduceCourtConfirmationMachine(next, { type: 'resolve_round', now: base + 1100 });
}

/** A never-challenged case parked at `fee_settlement`. */
function confirmedOnly(): CourtConfirmationMachineState {
  let s = confirmAll(createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: 2,
  }));
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 1000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 1100 });
  return reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
}

/** Cast a restored snapshot: the machine never mutates its input. */
function forge(
  state: CourtConfirmationMachineState,
  over: Record<string, unknown>,
): CourtConfirmationMachineState {
  return JSON.parse(JSON.stringify({ ...state, ...over })) as CourtConfirmationMachineState;
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the wire codec
// ─────────────────────────────────────────────────────────────────────────────

describe('T1 (r8-1) — caseId encodes injectively, or not at all', () => {
  it('a lone surrogate no longer collides with U+FFFD in the request hash', () => {
    // Before the fix BOTH of these were accepted and hashed identically:
    // TextEncoder maps U+D800 to U+FFFD, so two different case ids, two
    // different wire strings, one digest — the r7 H-6 collision one field over.
    expect(() => buildCourtEscalationRequest({
      ...request(), caseId: 'court:market-r48-wire:1\ud800',
    })).toThrow(/canonical UTF-8/);
    // The replacement character is itself canonical UTF-8, so it is accepted —
    // and it can no longer be confused with any other id.
    const replacement = buildCourtEscalationRequest({ ...request(), caseId: 'court:market-r48-wire:1\ufffd' });
    expect(replacement.caseId).toBe('court:market-r48-wire:1\ufffd');
    expect(hashCourtEscalationRequest(replacement)).not.toBe(hashCourtEscalationRequest(request()));
  });

  it('a NUL cannot blur a preimage field boundary, and the id is byte-bounded', () => {
    expect(() => buildCourtEscalationRequest({ ...request(), caseId: 'a\u0000b' })).toThrow(/U\+0000/);
    expect(() => buildCourtEscalationRequest({
      ...request(), caseId: 'a'.repeat(MAX_ESCALATION_CASE_ID_BYTES + 1),
    })).toThrow(/exceeds/);
    expect(buildCourtEscalationRequest({
      ...request(), caseId: 'a'.repeat(MAX_ESCALATION_CASE_ID_BYTES),
    }).caseId).toHaveLength(MAX_ESCALATION_CASE_ID_BYTES);
  });

  it('2 000 accepted case ids produce 2 000 distinct digests (injectivity pin)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      hashes.add(hashCourtEscalationRequest(buildCourtEscalationRequest({
        ...request(), caseId: `court:market-r48:${i}`,
      })));
    }
    expect(hashes.size).toBe(2_000);
  });
});

describe('T1 (r8-4) — a repeated field is refused, not silently resolved', () => {
  /** Insert a SECOND, earlier claim for `key` ahead of the canonical one. */
  const dup = (key: string, firstValueJson: string): string =>
    serializeCourtEscalationRequest(request())
      .replace(`"${key}":`, `"${key}":${firstValueJson},"${key}":`);

  it('"null then real" no longer parses to the real witness (JSON.parse last-wins)', () => {
    const body = dup('roundBondProofHash', 'null');
    // Sanity: JSON.parse alone reads ONE request out of TWO claims, and it is
    // the LAST claim — so the raw body and the parsed request disagree.
    expect((JSON.parse(body) as { roundBondProofHash: unknown }).roundBondProofHash).toBe(ROUND_BOND);
    expect(() => parseCourtEscalationRequest(body)).toThrow(/repeats the field roundBondProofHash/);
  });

  it('a repeated field spelled with a JSON escape is the same field', () => {
    const wire = JSON.parse(serializeCourtEscalationRequest(request())) as Record<string, unknown>;
    const body = JSON.stringify(wire).replace('"caseId":', '"c\\u0061seId":"court:other:1","caseId":');
    expect(() => parseCourtEscalationRequest(body)).toThrow(/repeats the field caseId/);
  });

  it('a repeated `concession` cannot flip a signed flag', () => {
    const body = dup('concession', 'true');
    expect((JSON.parse(body) as { concession: unknown }).concession).toBe(false);
    expect(() => parseCourtEscalationRequest(body)).toThrow(/repeats the field concession/);
  });

  it('the canonical form still parses (no false positive from the scanner)', () => {
    const built = request();
    expect(parseCourtEscalationRequest(serializeCourtEscalationRequest(built))).toEqual(built);
    // …including values that CONTAIN quotes, backslashes and braces in caseId.
    const tricky = buildCourtEscalationRequest({ ...request(), caseId: 'a"b\\c{}[]:,' });
    expect(parseCourtEscalationRequest(serializeCourtEscalationRequest(tricky))).toEqual(tricky);
  });

  it('the scanner never refuses a canonical serialisation (300 randomised ids)', () => {
    // A duplicate-key scanner that mis-tokenises is a denial of service on every
    // honest request, so the safety of the walk is pinned, not assumed.
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    const alphabet = ['a', 'Z', '0', '"', '\\', '{', '}', '[', ']', ':', ',', 'é', '中', ' ', '~', '/', '\u0001'];
    let checked = 0;
    for (let i = 0; i < 300; i += 1) {
      let id = '';
      const length = 1 + Math.floor(next() * 20);
      for (let j = 0; j < length; j += 1) id += alphabet[Math.floor(next() * alphabet.length)];
      let built: CourtEscalationRequest;
      try {
        built = buildCourtEscalationRequest({ ...request(), caseId: id });
      } catch {
        continue; // a different guard (empty / non-canonical) — not this test's subject
      }
      expect(parseCourtEscalationRequest(serializeCourtEscalationRequest(built))).toEqual(built);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('unknown fields, __proto__ and confusables are still refused', () => {
    const wire = wireOf(request());
    expect(() => parseCourtEscalationRequest({ ...wire, round_bond_proof_hash: ROUND_BOND }))
      .toThrow(/unknown field round_bond_proof_hash/);
    const proto = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(wire).slice(1)}`);
    expect(() => parseCourtEscalationRequest(proto)).toThrow(/unknown field __proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => parseCourtEscalationRequest({ ...wire, 'c\u0430seId': CASE_ID }))
      .toThrow(/unknown field/);
    expect(() => parseCourtEscalationRequest({ ...wire, 'round\u200d': 1 })).toThrow(/unknown field/);
    expect(() => parseCourtEscalationRequest({ ...wire, 'caseId\u0000x': 1 })).toThrow(/unknown field/);
  });
});

describe('T1 (H-6) — the "-" sentinel is a value no request field can be', () => {
  it('a literal "-" witness is refused, and absent ≠ present in the preimage', () => {
    expect(() => buildCourtEscalationRequest({ ...request(), roundBondProofHash: '-' }))
      .toThrow(/round_bond_proof_hash/);
    // "-" is legal as a caseId — it is a field VALUE there, never the slot
    // sentinel, and the slot it occupies is fixed by position.
    expect(buildCourtEscalationRequest({ ...request(), caseId: '-' }).caseId).toBe('-');
    expect(courtEscalationRequestPreimage(request({ roundBondProofHash: null })))
      .toBe(`${CASE_ID}\u00001\u0000${CHALLENGER_PUBKEY}\u0000${BOND_TXID}\u0000${MEMBERSHIP_BOND}\u0000-\u0000${EVENT_ID}\u00001790000000\u00000`);
    expect(hashCourtEscalationRequest(request({ roundBondProofHash: null })))
      .not.toBe(hashCourtEscalationRequest(request()));
  });
});

describe('T1 (r8-3) — a signed flag is not a truthiness test', () => {
  it('a non-boolean concession is refused instead of coerced to false', () => {
    for (const value of ['true', 1, 0, 'yes', {}, [], null]) {
      expect(() => parseCourtEscalationRequest({
        ...wireOf(request()), concession: value,
      })).toThrow(/concession must be a boolean/);
    }
    expect(parseCourtEscalationRequest({ ...wireOf(request()), concession: true }).concession).toBe(true);
    const absent = { ...wireOf(request()) };
    delete (absent as Record<string, unknown>).concession;
    expect(parseCourtEscalationRequest(absent).concession).toBe(false);
  });
});

describe('T1 (r8-5) — validate what you return: no getter double-fetch', () => {
  it('a shifting getter cannot be validated as A and returned as B', () => {
    let reads = 0;
    const shifty = {
      get caseId() {
        reads += 1;
        return 'court:A:1';
      },
      round: 1,
      challengerPubkey: CHALLENGER_PUBKEY,
      bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND,
      roundBondProofHash: null,
      eventId: EVENT_ID,
      signedAtSec: 1,
    };
    const built = buildCourtEscalationRequest(shifty as never);
    expect(built.caseId).toBe('court:A:1');
    expect(reads).toBe(1);
  });

  it('a non-string caseId fails with THIS module\'s typed error (not a raw TypeError)', () => {
    let reads = 0;
    const shifty = {
      get caseId(): string {
        reads += 1;
        return 42 as unknown as string;
      },
      round: 1,
      challengerPubkey: CHALLENGER_PUBKEY,
      bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND,
      roundBondProofHash: null,
      eventId: EVENT_ID,
      signedAtSec: 1,
    };
    let caught: unknown;
    try {
      buildCourtEscalationRequest(shifty as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(reads).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — wire → reducer
// ─────────────────────────────────────────────────────────────────────────────

describe('T2 (r8-2) — the mapping binds the three claims the reducer cannot check', () => {
  it('an escalation is refused when the case has no accepted challenge bond for it', () => {
    const state = resolvedRoundOne();
    expect(() => escalationRequestToMachineEvent(state, request({ bondProofHash: hexId('f') }), 3200, BINDING))
      .toThrow(/no accepted challenge bond/);
  });

  it('(a) challengerPubkey must be the pubkey the request authenticated as', () => {
    const state = resolvedRoundOne();
    // The attack: the bonded challenger (idx 2, from the case) names ANY juror's
    // pubkey. Before the fix this minted an event the reducer accepted and the
    // append-only log recorded the borrowed identity — the r29-2 attribution
    // harm (fees, bans) at mint time.
    expect(() => escalationRequestToMachineEvent(
      state,
      request({ challengerPubkey: OTHER_PUBKEY }),
      3200,
      BINDING,
    )).toThrow(/not the pubkey the request authenticated as/);
    // Positive control: the honest pair still maps.
    expect(escalationRequestToMachineEvent(state, request(), 3200, BINDING).challengerIdx).toBe(2);
  });

  it('(b) a stale request cannot open a round its signer never authorised', () => {
    const state = resolvedRoundOne({ maxLadderRounds: 3 });
    expect(state.ladderRound).toBe(1);
    // Signed to escalate past round 1, offered at round 3.
    const later = forge(state, { ladderRound: 3, phase: 'round_resolved' });
    expect(() => escalationRequestToMachineEvent(later, request({ round: 1 }), 3200, BINDING))
      .toThrow(/signed to escalate past round 1 but the case is resolving round 3/);
    expect(() => escalationRequestToMachineEvent(state, request({ round: 2 }), 3200, BINDING))
      .toThrow(/signed to escalate past round 2/);
  });

  it('(c) a request cannot cross cases', () => {
    const state = resolvedRoundOne();
    const foreign = request({ caseId: 'court:market-someone-else:42' });
    expect(() => escalationRequestToMachineEvent(state, foreign, 3200, BINDING))
      .toThrow(/must not cross cases/);
  });

  it('an UNBOUND call is a refusal, not a silent pass', () => {
    const state = resolvedRoundOne();
    expect(() => (escalationRequestToMachineEvent as (...args: unknown[]) => unknown)(
      state, request(), 3200,
    )).toThrow(/binding is required/);
    expect(() => escalationRequestToMachineEvent(state, request(), 3200, {
      caseId: '', authenticatedPubkey: CHALLENGER_PUBKEY,
    })).toThrow(/binding caseId/);
    expect(() => escalationRequestToMachineEvent(state, request(), 3200, {
      caseId: CASE_ID, authenticatedPubkey: 'nothex',
    })).toThrow(/authenticatedPubkey/);
  });

  it('an ambiguous bond ledger (one hash, two owners) is refused rather than resolved', () => {
    const state = resolvedRoundOne();
    const ambiguous = forge(state, {
      challenges: [
        { ...state.challenges[0] },
        { ...state.challenges[0], idx: 3, eventId: hid('c3') },
      ],
    });
    expect(() => escalationRequestToMachineEvent(ambiguous, request(), 3200, BINDING))
      .toThrow(/witness is ambiguous/);
  });

  it('the wire `now` is the HOST clock: the request cannot steer it, and NaN is refused', () => {
    const state = resolvedRoundOne();
    const farFuture = request({ signedAtSec: 9_999_999_999 });
    expect(escalationRequestToMachineEvent(state, farFuture, 3200, BINDING).now).toBe(3200);
    expect(() => escalationRequestToMachineEvent(state, request(), Number.NaN, BINDING))
      .toThrow(/now must be a non-negative safe integer/);
    // …and the reducer's own clock ledger refuses a rolled-back host clock.
    const escalate = escalationRequestToMachineEvent(state, request(), 3200, BINDING);
    const next = reduceCourtConfirmationMachine(state, escalate);
    expect(next.latestTimestamp).toBe(3200);
    expect(() => reduceCourtConfirmationMachine(state, escalationRequestToMachineEvent(state, request(), 3100, BINDING)))
      .toThrow(/now must not precede/);
  });

  it('over-strictness: the strict case still escalates end-to-end through the wire', () => {
    const state = resolvedRoundOne({ requireRoundBond: true });
    const transported = parseCourtEscalationRequest(serializeCourtEscalationRequest(request()));
    const next = reduceCourtConfirmationMachine(
      state,
      escalationRequestToMachineEvent(state, transported, 3200, BINDING),
    );
    expect(next.phase).toBe('ladder_pending');
    expect(next.escalationLog.at(-1)).toMatchObject({
      round: 2,
      challengerIdx: 2,
      challengerPubkey: CHALLENGER_PUBKEY,
      roundBondProofHash: ROUND_BOND,
    });
  });

  it('over-strictness: a request built for the round the case IS resolving is accepted', () => {
    let s = resolvedRoundOne({ maxLadderRounds: 3 });
    s = reduceCourtConfirmationMachine(s, escalationRequestToMachineEvent(s, request(), 3200, BINDING));
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 2, voteDeadline: 4300, now: 3300 });
    for (const idx of ROSTER) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_mass_vote', idx, outcome: 'NO', eventId: hid(`g${idx}`), now: 3400 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 4300 });
    s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 4400 });
    expect(s.ladderRound).toBe(2);
    const roundTwo = request({ round: 2, roundBondProofHash: hid('b3') });
    const next = reduceCourtConfirmationMachine(s, escalationRequestToMachineEvent(s, roundTwo, 4500, BINDING));
    expect(next.phase).toBe('ladder_pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the round-7 finality barrier
// ─────────────────────────────────────────────────────────────────────────────

describe('T3 (r41-1) — the barrier runs on EVERY path to finalize', () => {
  it('never-challenged path: finalizes on the standing proposal, and a forged history is refused', () => {
    const parked = confirmedOnly();
    expect(parked.phase).toBe('fee_settlement');
    const final = reduceCourtConfirmationMachine(parked, { type: 'finalize', now: 2100 });
    expect(final.phase).toBe('final');
    expect(final.verdict).toMatchObject({ outcome: 'YES', upheld: true });
    // The one forged thing this path can carry: a resolved-round record on a
    // case that was never challenged (which would mean the verdict should be
    // the round's winner, not the proposal).
    const forged = forge(parked, {
      outcomeHistory: [{ round: 1, outcome: 'NO', winnerEventIds: [hid('z1')], winnerIndices: [1] }],
    });
    expect(() => reduceCourtConfirmationMachine(forged, { type: 'finalize', now: 2100 }))
      .toThrow(/never challenged/);
  });

  it('concede path: finalizes the round-1 outcome, and a forged vote ledger is refused', () => {
    const conceded = reduceCourtConfirmationMachine(resolvedRoundOne(), { type: 'concede', now: 3300 });
    expect(conceded.phase).toBe('fee_settlement');
    const final = reduceCourtConfirmationMachine(conceded, { type: 'finalize', now: 3400 });
    expect(final.verdict).toMatchObject({ outcome: 'NO', upheld: false });
    expect(final.verdict?.supportingEventIds).toHaveLength(3);

    // The r41-1 route, re-attacked: `concede` reads no ledger, so the forged
    // vote ledger survives it — and `finalize` must refuse it.
    const forgedVotes = forge(resolvedRoundOne(), {
      ladder: {
        ...resolvedRoundOne().ladder!,
        votes: [{ idx: 1, outcome: 'YES', eventId: hid('f1') }],
      },
      verdict: { outcome: 'YES', upheld: true, verdictHash: '', supportingEventIds: [] },
    });
    const forgedConceded = reduceCourtConfirmationMachine(forgedVotes, { type: 'concede', now: 3300 });
    expect(forgedConceded.phase).toBe('fee_settlement');
    expect(() => reduceCourtConfirmationMachine(forgedConceded, { type: 'finalize', now: 3400 }))
      .toThrow(/vote ledger tallies "YES" but the recorded outcome is "NO"/);
  });

  it('resolved→concede path: a pending verdict that disagrees with the ledgers is refused', () => {
    const parked = resolvedRoundOne();
    const flipped = forge(parked, {
      verdict: { outcome: 'YES', upheld: true, verdictHash: '', supportingEventIds: [] },
    });
    const conceded = reduceCourtConfirmationMachine(flipped, { type: 'concede', now: 3300 });
    expect(() => reduceCourtConfirmationMachine(conceded, { type: 'finalize', now: 3400 }))
      .toThrow(/pending verdict names "YES" but the verified ledgers derive "NO"/);
  });

  it('last-round path (resolve_round → fee_settlement): duplicates are refused', () => {
    let s = resolvedRoundOne({ maxLadderRounds: 1 });
    expect(s.phase).toBe('fee_settlement');
    s = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 3300 });
    expect(s.verdict).toMatchObject({ outcome: 'NO', upheld: false });

    const duplicateBallots = resolvedRoundOne({ maxLadderRounds: 1 });
    const forged = forge(duplicateBallots, {
      ladder: {
        ...duplicateBallots.ladder!,
        votes: [
          { idx: 1, outcome: 'NO', eventId: hid('a1') },
          { idx: 1, outcome: 'YES', eventId: hid('a2') },
          { idx: 2, outcome: 'NO', eventId: hid('a3') },
        ],
      },
    });
    expect(() => reduceCourtConfirmationMachine(forged, { type: 'finalize', now: 3300 }))
      .toThrow(/duplicate mass votes/);
  });

  it('a CONSISTENT manufactured history is accepted — provenance is the host\'s, consistency is ours', () => {
    // The boundary, stated as a test: if an attacker rewrites the vote ledger
    // AND the history record AND the pending verdict to agree, no barrier in a
    // pure state machine can tell that from an honest round. Signatures over the
    // ballots are the host's admission check (`accept_mass_vote`'s caller).
    const parked = resolvedRoundOne();
    const manufactured = forge(parked, {
      phase: 'fee_settlement',
      outcomeHistory: [{ round: 1, outcome: 'YES', winnerEventIds: [hid('x1')], winnerIndices: [1] }],
      ladder: { ...parked.ladder!, votes: [{ idx: 1, outcome: 'YES', eventId: hid('x1') }] },
      verdict: { outcome: 'YES', upheld: true, verdictHash: '', supportingEventIds: [] },
    });
    const final = reduceCourtConfirmationMachine(manufactured, { type: 'finalize', now: 3300 });
    expect(final.verdict).toMatchObject({ outcome: 'YES', upheld: true });
    // …whereas touching ONLY the history (leaving the honest votes) is caught:
    const historyOnly = forge(parked, {
      phase: 'fee_settlement',
      outcomeHistory: [{ round: 1, outcome: 'YES', winnerEventIds: [hid('x1')], winnerIndices: [1] }],
      verdict: { outcome: 'YES', upheld: true, verdictHash: '', supportingEventIds: [] },
    });
    expect(() => reduceCourtConfirmationMachine(historyOnly, { type: 'finalize', now: 3300 }))
      .toThrow(/vote ledger tallies "NO" but the recorded outcome is "YES"/);
  });

  it('a history with an EXTRA round cannot reach a verdict', () => {
    const parked = resolvedRoundOne();
    const inflated = forge(parked, {
      phase: 'fee_settlement',
      outcomeHistory: [
        { round: 1, outcome: 'NO', winnerEventIds: [hid('a1')], winnerIndices: [1] },
        { round: 2, outcome: 'YES', winnerEventIds: [hid('a2')], winnerIndices: [2] },
      ],
    });
    expect(() => reduceCourtConfirmationMachine(inflated, { type: 'finalize', now: 3300 }))
      .toThrow(/last resolved round is 2 but the ladder is at round 1/);
  });
});

describe('T3 (r8-6) — resolve_round re-checks that the history is ONE record per resolved round', () => {
  it('a restored snapshot whose ladder outran its history is refused, not bricked', () => {
    const three = resolvedRoundOne({ maxLadderRounds: 5 });
    expect(three.ladderRound).toBe(1);
    expect(three.outcomeHistory.map((r) => r.round)).toEqual([1]);
    const skipped = forge(three, {
      ladderRound: 4,
      phase: 'ladder_vote_closed',
      ladder: {
        round: 4,
        voteDeadline: 9000,
        votes: [{ idx: 1, outcome: 'YES', eventId: hid('9a') }],
        roundRoster: [...ROSTER],
      },
    });
    // Before the fix this appended round 4 on top of a one-record history,
    // producing [1, 4] — a history NO later barrier accepts, so the case could
    // never finalize again (the r40-2 brick, with value locked in escrow).
    expect(() => reduceCourtConfirmationMachine(skipped, { type: 'resolve_round', now: 9500 }))
      .toThrow(/outcome history holds 1 record\(s\) but 3 round\(s\) were resolved/);
  });

  it('every legal resolve still passes (over-strictness control)', () => {
    let s = resolvedRoundOne({ maxLadderRounds: 3 });
    s = reduceCourtConfirmationMachine(s, escalationRequestToMachineEvent(s, request(), 3200, BINDING));
    s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 2, voteDeadline: 4300, now: 3300 });
    for (const idx of ROSTER) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_mass_vote', idx, outcome: 'NO', eventId: hid(`h${idx}`), now: 3400 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 4300 });
    const roundTwo = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 4400 });
    expect(roundTwo.outcomeHistory.map((r) => r.round)).toEqual([1, 2]);
    expect(roundTwo.phase).toBe('round_resolved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the four r41-1 closures from #112
// ─────────────────────────────────────────────────────────────────────────────

describe('T4 — the four #112 closures are guards, not restatements', () => {
  it('closure 1: `concede` reads no ledger (so `finalize` must)', () => {
    const parked = resolvedRoundOne();
    const forged = forge(parked, {
      ladder: { ...parked.ladder!, votes: [{ idx: 1, outcome: 'YES', eventId: hid('f1') }] },
    });
    // The precondition of the fix: concede alone cannot catch this.
    expect(reduceCourtConfirmationMachine(forged, { type: 'concede', now: 3300 }).phase).toBe('fee_settlement');
    // The fix: finalize does.
    expect(() => reduceCourtConfirmationMachine(
      reduceCourtConfirmationMachine(forged, { type: 'concede', now: 3300 }),
      { type: 'finalize', now: 3400 },
    )).toThrow(CourtConfirmationTransitionError);
  });

  it('closure 2: a losing outcome cannot be minted as the canonical verdict', () => {
    const parked = resolvedRoundOne();
    const forged = forge(parked, {
      phase: 'fee_settlement',
      ladder: { ...parked.ladder!, votes: [{ idx: 1, outcome: 'MAYBE', eventId: hid('f1') }] },
      verdict: { outcome: 'MAYBE', upheld: true, verdictHash: '', supportingEventIds: [] },
    });
    // 'MAYBE' is not even on the ballot: the vote-ledger barrier refuses it.
    expect(() => reduceCourtConfirmationMachine(forged, { type: 'finalize', now: 3300 }))
      .toThrow(/outside the frozen allowlist/);
  });

  it('closure 3: the supporting set is the recorded winners, not the padded ledger', () => {
    const parked = resolvedRoundOne();
    const padded = forge(parked, {
      phase: 'fee_settlement',
      ladder: {
        ...parked.ladder!,
        votes: [
          ...parked.ladder!.votes,
          { idx: 1, outcome: 'NO', eventId: hid('dupe') },
        ],
      },
    });
    expect(() => reduceCourtConfirmationMachine(padded, { type: 'finalize', now: 3300 }))
      .toThrow(/duplicate mass votes/);
    const honest = reduceCourtConfirmationMachine(parked, { type: 'concede', now: 3300 });
    const final = reduceCourtConfirmationMachine(honest, { type: 'finalize', now: 3400 });
    expect(final.verdict?.supportingEventIds).toEqual(
      [...parked.ladder!.votes.map((v) => v.eventId.toLowerCase())].sort(),
    );
  });

  it('closure 4: `upheld` is derived, not read from the snapshot (it is not in the hash)', () => {
    const parked = resolvedRoundOne();
    const flipped = forge(parked, {
      phase: 'fee_settlement',
      verdict: { outcome: 'NO', upheld: true, verdictHash: '', supportingEventIds: [] },
    });
    expect(() => reduceCourtConfirmationMachine(flipped, { type: 'finalize', now: 3300 }))
      .toThrow(/sets upheld=true but the verified ledgers derive upheld=false/);
  });
});
