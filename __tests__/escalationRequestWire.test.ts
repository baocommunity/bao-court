// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * R43 / review-round 7 H-6 — TRANSPORT BEFORE ENFORCEMENT.
 *
 * The registered finding: the strict round-bond policy (`requireRoundBond`,
 * default TRUE for new cases since v0.13.2) demands `roundBondProofHash`, but
 * the artefact the host transports had no field for it — so the policy could be
 * enforced before the witness could travel, and every escalation on a strict
 * case would be refused. The request hash did not bind the witness either, so
 * two different round bonds would have hashed to ONE request hash.
 *
 * What is pinned here:
 *
 *   1. ROUND-TRIP — build → serialise → parse is identity, and the parse is
 *      strict (unknown fields, junk, malformed hex, bad rounds all refuse);
 *   2. THE FIELD-BY-FIELD AUDIT — the machine event built from a parsed request
 *      carries every field the reducer's `escalate` arm expects, and the values
 *      the CHALLENGER must not choose (`challengerIdx`, `roundIndex`) come from
 *      the case, not the wire;
 *   3. THE STRICT PATH ACCEPTS A TRANSPORTED ROUND BOND — a request carrying
 *      `roundBondProofHash` walks through the codec, through
 *      `escalationRequestToMachineEvent` and into a `requireRoundBond: true`
 *      case, which records the witness in its append-only log; the same request
 *      with the witness removed is refused by the reducer;
 *   4. THE HASH BINDS THE ROUND BOND — two requests differing only in
 *      `roundBondProofHash` have different hashes (the r7 H-6 collision), and
 *      the known-answer digest is pinned so the host's byte-identical
 *      implementation (`CourtEscalationService.ts`) cannot drift;
 *   5. THE COMPAT MATRIX says transport must ship first (doc pin).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COURT_ESCALATION_REQUEST_DOMAIN,
  buildCourtEscalationRequest,
  courtEscalationRequestPreimage,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
  type CourtEscalationRequest,
} from '../courtEscalationRequest';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { hexId, padHexId } from './helpers/ids';

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;
const BOND_TXID = hexId('d');
const MEMBERSHIP_BOND = hexId('e');
const CHALLENGER_PUBKEY = hexId('7');
const EVENT_ID = hexId('8');
const CASE_ID = 'court:market-r43-wire:1';
const ROUND_BOND = padHexId('a2');

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

/** A challenged case parked at `round_resolved` after round 1 (juror 2 bonded). */
function resolvedRoundOne(opts: { requireRoundBond?: boolean } = {}): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: 2,
    ...(opts.requireRoundBond === undefined ? {} : { requireRoundBond: opts.requireRoundBond }),
  });
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: padHexId(`c${idx}`),
      now: 100 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 1000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 1100 });
  s = reduceCourtConfirmationMachine(s, {
    type: 'accept_challenge',
    idx: 2,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    eventId: padHexId('c2'),
    now: 1500,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  s = reduceCourtConfirmationMachine(s, { type: 'open_ladder_round', round: 1, voteDeadline: 3000, now: 2100 });
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_mass_vote', idx, outcome: 'NO', eventId: padHexId(`a${idx}`), now: 2200 + idx,
    });
  }
  s = reduceCourtConfirmationMachine(s, { type: 'close_ladder_round', now: 3000 });
  s = reduceCourtConfirmationMachine(s, { type: 'resolve_round', now: 3100 });
  expect(s.phase).toBe('round_resolved');
  return s;
}

describe('(H-6) the escalation request wire round-trips, and the parse is strict', () => {
  it('build → serialise → parse is the identity, witness included', () => {
    const built = request();
    const parsed = parseCourtEscalationRequest(serializeCourtEscalationRequest(built));
    expect(parsed).toEqual(built);
    // A parsed request can be re-serialised to the same bytes (canonical order).
    expect(serializeCourtEscalationRequest(parsed)).toBe(serializeCourtEscalationRequest(built));
    // The wire always carries the slot, so "absent" is explicit rather than a
    // dropped field — the shape H-6 was about.
    expect(JSON.parse(serializeCourtEscalationRequest(built)).roundBondProofHash).toBe(ROUND_BOND);
    const legacy = request({ roundBondProofHash: null });
    expect(JSON.parse(serializeCourtEscalationRequest(legacy)).roundBondProofHash).toBeNull();
    expect(parseCourtEscalationRequest(serializeCourtEscalationRequest(legacy))).toEqual(legacy);
  });

  it('accepts an object as well as a JSON string, and defaults the optional fields', () => {
    const parsed = parseCourtEscalationRequest({
      caseId: CASE_ID,
      round: 2,
      challengerPubkey: CHALLENGER_PUBKEY,
      bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND,
      eventId: EVENT_ID,
      signedAtSec: 10,
    });
    expect(parsed.roundBondProofHash).toBeNull();
    expect(parsed.concession).toBe(false);
  });

  it('refuses unknown fields (additionalProperties: false is the wire contract)', () => {
    const wire = JSON.parse(serializeCourtEscalationRequest(request())) as Record<string, unknown>;
    wire.round_bond_proof_hash = ROUND_BOND; // the snake_case spelling the host body USED to miss
    expect(() => parseCourtEscalationRequest(wire)).toThrow(/unknown field round_bond_proof_hash/);
  });

  it('refuses junk: bad JSON, non-objects, malformed hex, bad rounds, bad clock', () => {
    expect(() => parseCourtEscalationRequest('{not json')).toThrow(/not valid JSON/);
    expect(() => parseCourtEscalationRequest('[]')).toThrow(/must be a JSON object/);
    expect(() => parseCourtEscalationRequest(null)).toThrow(/must be a JSON object/);
    const base = request();
    expect(() => buildCourtEscalationRequest({ ...base, bondProofHash: 'deadbeef' })).toThrow(/bond_proof_hash/);
    expect(() => buildCourtEscalationRequest({ ...base, roundBondProofHash: 'zz' })).toThrow(/round_bond_proof_hash/);
    expect(() => buildCourtEscalationRequest({ ...base, round: 0 })).toThrow(/round must be an integer/);
    expect(() => buildCourtEscalationRequest({ ...base, round: 6 })).toThrow(/round must be an integer/);
    expect(() => buildCourtEscalationRequest({ ...base, signedAtSec: -1 })).toThrow(/signedAtSec/);
    expect(() => buildCourtEscalationRequest({ ...base, caseId: '   ' })).toThrow(/caseId/);
  });
});

describe('(H-6) the machine event built from the wire is field-for-field the reducer\'s', () => {
  it('carries every witness field, and takes only the host-known fields from the CASE', () => {
    const state = resolvedRoundOne();
    const event = escalationRequestToMachineEvent(state, request(), 3200);
    expect(event).toEqual({
      type: 'escalate',
      authority: 'challenger',
      // From the CASE (the challenger cannot choose its roster index)…
      challengerIdx: 2,
      // …and from the WIRE:
      challengerPubkey: CHALLENGER_PUBKEY,
      requestHash: hashCourtEscalationRequest(request()),
      bondProofHash: MEMBERSHIP_BOND,
      roundBondProofHash: ROUND_BOND,
      // From the CASE: exactly the next round.
      roundIndex: 2,
      now: 3200,
    });
    // Every key the reducer's `escalate` arm declares is present.
    const expecting: Array<keyof typeof event> = [
      'type', 'authority', 'challengerIdx', 'challengerPubkey',
      'requestHash', 'bondProofHash', 'roundBondProofHash', 'roundIndex', 'now',
    ];
    expect(Object.keys(event).sort()).toEqual([...expecting].sort());
  });

  it('omits the optional witness (rather than sending null) on a legacy request', () => {
    const state = resolvedRoundOne();
    const event = escalationRequestToMachineEvent(state, request({ roundBondProofHash: null }), 3200);
    expect('roundBondProofHash' in event).toBe(false);
  });

  it('fails closed when the case has no accepted challenge carrying the membership bond', () => {
    const state = resolvedRoundOne();
    expect(() => escalationRequestToMachineEvent(
      state,
      request({ bondProofHash: hexId('f') }),
      3200,
    )).toThrow(/no accepted challenge bond/);
  });
});

describe('(H-6) the strict path ACCEPTS a transported round bond', () => {
  it('a request with a round bond escalates a requireRoundBond case and is logged', () => {
    const state = resolvedRoundOne({ requireRoundBond: true });
    expect(state.requireRoundBond).toBe(true);
    const transported = parseCourtEscalationRequest(serializeCourtEscalationRequest(request()));
    const event = escalationRequestToMachineEvent(state, transported, 3200);
    const next = reduceCourtConfirmationMachine(state, event);
    expect(next.phase).toBe('ladder_pending');
    // `escalate` records round 2 and parks at `ladder_pending`; the round itself
    // is opened by the host's `open_ladder_round`, so `ladderRound` is still 1
    // here (the append-only log is the authority on what was opened).
    expect(next.ladderRound).toBe(1);
    const record = next.escalationLog.at(-1);
    expect(record).toMatchObject({
      round: 2,
      authority: 'challenger',
      challengerIdx: 2,
      challengerPubkey: CHALLENGER_PUBKEY,
      requestHash: hashCourtEscalationRequest(transported),
      bondProofHash: MEMBERSHIP_BOND,
      roundBondProofHash: ROUND_BOND,
    });
  });

  it('the SAME transported request without the witness is refused by the strict case', () => {
    const state = resolvedRoundOne({ requireRoundBond: true });
    const withoutWitness = escalationRequestToMachineEvent(
      state,
      parseCourtEscalationRequest(serializeCourtEscalationRequest(request({ roundBondProofHash: null }))),
      3200,
    );
    expect(() => reduceCourtConfirmationMachine(state, withoutWitness)).toThrow(
      /requires a per-round bond witness/,
    );
    // …and the legacy case still accepts it (the v0.12 membership semantics).
    const legacy = resolvedRoundOne({ requireRoundBond: false });
    const accepted = reduceCourtConfirmationMachine(legacy, withoutWitness);
    expect(accepted.phase).toBe('ladder_pending');
  });
});

describe('(H-6) the request hash binds the round-bond witness', () => {
  it('two requests differing ONLY in the round bond hash differently', () => {
    const a = hashCourtEscalationRequest(request());
    const b = hashCourtEscalationRequest(request({ roundBondProofHash: padHexId('a3') }));
    const c = hashCourtEscalationRequest(request({ roundBondProofHash: null }));
    expect(new Set([a, b, c]).size).toBe(3);
    // The absent slot is the '-' sentinel, so null can never collide with hex.
    expect(courtEscalationRequestPreimage(request({ roundBondProofHash: null })))
      .toContain(`\u0000${MEMBERSHIP_BOND}\u0000-\u0000${EVENT_ID}\u0000`);
  });

  it('pins the v2 domain and a known-answer digest shared with the host', () => {
    expect(COURT_ESCALATION_REQUEST_DOMAIN).toBe('BAO-Court/Escalation/Request/v2');
    // KNOWN ANSWER — the host's `hashEscalationRequest` must produce the SAME
    // digest for the same request (its suite pins the same constant). A v1 hash
    // ignored the round bond; v2 cannot.
    expect(hashCourtEscalationRequest(buildCourtEscalationRequest({
      caseId: 'court:market-r43-wire:1',
      round: 1,
      challengerPubkey: '7'.repeat(64),
      bondTxid: 'd'.repeat(64),
      bondProofHash: 'e'.repeat(64),
      roundBondProofHash: 'a'.repeat(64),
      eventId: '8'.repeat(64),
      signedAtSec: 1_790_000_000,
    }))).toBe('38f94655c82847e158c451d02e338db9f6742d23556c029ed6b7773e0e0bab5f');
  });
});

describe('(H-6) the compat matrix documents the order of operations', () => {
  it('PER_ROUND_BOND.md says the transport ships BEFORE the policy is enforced', () => {
    const bond = readFileSync(new URL('../docs/PER_ROUND_BOND.md', import.meta.url), 'utf8');
    expect(bond).toMatch(/transport must carry the witness BEFORE the policy requires it/);
    expect(bond).toMatch(/H-6/);
    expect(bond).toMatch(/courtEscalationRequest/);
    expect(bond).toMatch(/roundBondProofHash/);
  });
});
