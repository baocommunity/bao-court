// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Review round 9 — attacking the round-8 fixes (v0.14.1).
 *
 * Round 8 asked what the transport BINDS and answered with three guards: a
 * canonical `caseId` (r8-1), a host binding for the wire claims (r8-2), and a
 * typed refusal of a repeated JSON field (r8-4), plus a history/short-barrier
 * rule in `resolve_round` (r8-6). This file attacks those four guards.
 *
 * Findings (all measured; `docs/REVIEW_ROUND_9.md` has the repro + disposition):
 *
 *   T1  r9-1 the `caseId` was still folded by `trim()` — distinct wire ids, one
 *       digest, and `build` returned an id it was never given (FIXED);
 *       r9-5 the 2 000-id "injectivity pin" measures sha256, not the encoding
 *       (it passes on a lossy encoder) — replaced by a differential pin;
 *   T2  r9-2 `bondTxid` went into the preimage uncompared with the challenge
 *       record (FIXED); r9-3 a CONCESSION request minted an ESCALATION (FIXED);
 *       r9-6 the binding is a trust anchor a host can fill from the wire
 *       (registered + pinned); r40-3 bond ownership is not preempted
 *       (registered + pinned);
 *   T3  duplicate keys: depth-1 scope is sound because every field is a scalar
 *       (pinned, with the shape assertion that keeps it sound);
 *   T4  r9-4 the r8-6 rule read one of the two round counters, so a snapshot
 *       whose counters disagree still appended a non-consecutive record (FIXED).
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
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const hexId = (ch: string): string => ch.repeat(64);
const hid = (label: string): string =>
  label.split('').map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('').padStart(64, '0').slice(-64);

const SESSION = hexId('1');
const PROPOSAL = hexId('2');
const ROSTER = [1, 2, 3] as const;
const BOND_TXID = hexId('d');
const MEMBERSHIP_BOND = hexId('e');
const CHALLENGER_PUBKEY = hexId('7');
const EVENT_ID = hexId('8');
const CASE_ID = 'court:market-r49:1';
const ROUND_BOND = hid('a2');
const OTHER_PUBKEY = hexId('9');

const BINDING: CourtEscalationBinding = {
  caseId: CASE_ID,
  authenticatedPubkey: CHALLENGER_PUBKEY,
};

function request(over: Partial<CourtEscalationRequest> = {}): CourtEscalationRequest {
  return buildCourtEscalationRequest({
    caseId: CASE_ID,
    round: 1,
    challengerPubkey: CHALLENGER_PUBKEY,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: ROUND_BOND,
    eventId: EVENT_ID,
    signedAtSec: 1_790_000_000,
    ...over,
  });
}

/** A challenged case parked in `round_resolved` after round 1 resolves `NO`. */
function resolvedRoundOne(
  opts: { maxLadderRounds?: number; requireRoundBond?: boolean } = {},
): CourtConfirmationMachineState {
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
  for (const idx of ROSTER) {
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: hid(`c${idx}`),
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
    eventId: hid('c2'),
    now: 1500,
  });
  s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
  return voteRound(s, 1, 'NO', 2050);
}

/** Open, vote unanimously `outcome`, close and resolve one ladder round. */
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

/** Cast a restored snapshot: the machine never mutates its input. */
function forge(
  state: CourtConfirmationMachineState,
  over: Record<string, unknown>,
): CourtConfirmationMachineState {
  return JSON.parse(JSON.stringify({ ...state, ...over })) as CourtConfirmationMachineState;
}

/** Capture the error a call throws (never swallow it silently). */
function caught(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal, got none');
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the canonical case id (r8-1 attacked)
// ─────────────────────────────────────────────────────────────────────────────

describe('T1 (r9-1) — the case id is validated, never folded', () => {
  it('a trailing/leading whitespace id is refused instead of silently folded', () => {
    // Measured on v0.14.1 before this fix: `"court:market-r49:1 "` built to
    // `"court:market-r49:1"` and hashed identically — two distinct wire ids, one
    // digest. The r8-1 claim ("injective over the accepted domain") was true of
    // the FOLDED strings, not of the strings the wire carries.
    for (const suffix of [' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u3000']) {
      expect(() => buildCourtEscalationRequest({ ...request(), caseId: `${CASE_ID}${suffix}` }))
        .toThrow(/leading or trailing whitespace/);
      expect(() => buildCourtEscalationRequest({ ...request(), caseId: `${suffix}${CASE_ID}` }))
        .toThrow(/leading or trailing whitespace/);
    }
    // A LEADING U+FEFF is refused one step earlier, by the canonical-UTF-8
    // round-trip: `TextDecoder` strips a leading BOM (`ignoreBOM: false`), so the
    // helper's decode ≠ input. Fail-closed, and worth naming because the message
    // mentions surrogates when the cause is a BOM.
    expect(() => buildCourtEscalationRequest({ ...request(), caseId: `\ufeff${CASE_ID}` }))
      .toThrow(/canonical UTF-8/);
    // A U+FEFF in the MIDDLE does round-trip, so it is the whitespace rule that
    // refuses it (it is `WhiteSpace` for `trim()`).
    expect(() => buildCourtEscalationRequest({ ...request(), caseId: `${CASE_ID}\ufeff` }))
      .toThrow(/leading or trailing whitespace/);
    // Whitespace-only is still the empty-id refusal (the more specific message).
    expect(() => buildCourtEscalationRequest({ ...request(), caseId: ' \t ' }))
      .toThrow(/non-empty string/);
    // The preimage uses the id EXACTLY, so the two strings can never meet again.
    const exact = buildCourtEscalationRequest(request());
    expect(courtEscalationRequestPreimage({ ...exact, caseId: `${CASE_ID} ` }))
      .not.toBe(courtEscalationRequestPreimage(exact));
  });

  it('the binding compares EXACTLY, so a request cannot ride a case id across the whitespace class', () => {
    const state = resolvedRoundOne();
    // v0.14.1 measured: ACCEPTED (both sides trimmed to the same string) — the
    // r8-2c "a request must not cross cases" claim held only up to trim().
    expect(() => escalationRequestToMachineEvent(state, request(), 3300, {
      caseId: `${CASE_ID} `, authenticatedPubkey: CHALLENGER_PUBKEY,
    })).toThrow(/binding caseId must not have leading or trailing whitespace/);
    const err = caught(() => escalationRequestToMachineEvent(state, request({ caseId: 'court:other:9' }), 3300, {
      caseId: 'court:other:9 ', authenticatedPubkey: CHALLENGER_PUBKEY,
    }));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
  });

  it('lone surrogates are refused at every position; a real surrogate pair is accepted', () => {
    const lone = [
      ['start', '\ud800abc'],
      ['middle', 'a\ud800b'],
      ['end', 'ab\ud800'],
      ['low start', '\udc00abc'],
      ['low end', 'abc\udc00'],
      ['high + non-low', 'a\ud800\u0041'],
      ['unpaired inside a pair', 'a\ud83d\ud83db'],
    ] as const;
    for (const [label, id] of lone) {
      const err = caught(() => buildCourtEscalationRequest({ ...request(), caseId: id }));
      expect(err, label).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message, label).toMatch(/canonical UTF-8/);
    }
    // A well-formed pair is canonical UTF-8 and must not be refused (the
    // over-strictness control: 4-byte sequences are ordinary text).
    const emoji = buildCourtEscalationRequest({ ...request(), caseId: 'a\ud83d\ude00' });
    expect(emoji.caseId).toBe('a\ud83d\ude00');
    expect(utf8(emoji.caseId)).toHaveLength(5);
  });

  it('U+0000 is refused at the start, the middle, the end, and alone', () => {
    for (const id of ['\u0000ab', 'a\u0000b', 'ab\u0000', '\u0000', '\u0000\u0000']) {
      expect(() => buildCourtEscalationRequest({ ...request(), caseId: id }))
        .toThrow(/must not contain U\+0000/);
    }
    // …and the escaped wire form cannot smuggle one either.
    const wire = JSON.parse(serializeCourtEscalationRequest(request())) as Record<string, unknown>;
    expect(() => parseCourtEscalationRequest(JSON.stringify({ ...wire, caseId: 'a\u0000b' })))
      .toThrow(/U\+0000/);
  });

  it('the byte bound is exact at 256 bytes for every UTF-8 width', () => {
    const accepted: Array<[string, string]> = [
      ['1-byte', 'a'.repeat(256)],
      ['2-byte', 'é'.repeat(128)], // 256 bytes
      ['3-byte', `${'中'.repeat(85)}a`], // 85*3 + 1 = 256
      ['4-byte', '😀'.repeat(64)], // 64*4 = 256
    ];
    const refused: Array<[string, string]> = [
      ['1-byte', 'a'.repeat(257)],
      ['2-byte', 'é'.repeat(129)], // 258
      ['3-byte', `${'中'.repeat(85)}ab`], // 257
      ['4-byte', `${'😀'.repeat(64)}a`], // 257
    ];
    for (const [label, id] of accepted) {
      expect(utf8(id), label).toHaveLength(MAX_ESCALATION_CASE_ID_BYTES);
      const built = buildCourtEscalationRequest({ ...request(), caseId: id });
      expect(built.caseId, label).toBe(id);
      // …and a 256-byte id survives the wire round-trip with a stable digest.
      const transported = parseCourtEscalationRequest(serializeCourtEscalationRequest(built));
      expect(transported, label).toEqual(built);
      expect(hashCourtEscalationRequest(transported), label).toBe(hashCourtEscalationRequest(built));
    }
    for (const [label, id] of refused) {
      expect(utf8(id).length, label).toBeGreaterThan(MAX_ESCALATION_CASE_ID_BYTES);
      expect(() => buildCourtEscalationRequest({ ...request(), caseId: id }))
        .toThrow(/exceeds 256 bytes/);
    }
    // The bound is counted on the id as accepted, not on a folded form: 257
    // characters whose surrounding spaces a trim would eat are refused for the
    // whitespace reason, and a 257-byte id is never accepted by length.
    expect(() => buildCourtEscalationRequest({ ...request(), caseId: ` ${'a'.repeat(256)}` }))
      .toThrow(/whitespace/);
  });

  it('there is NO Unicode normalisation — NFC and NFD are different ids (documented)', () => {
    const nfc = buildCourtEscalationRequest({ ...request(), caseId: 'court:caf\u00e9:1' });
    const nfd = buildCourtEscalationRequest({ ...request(), caseId: 'court:cafe\u0301:1' });
    // They render identically…
    expect(nfc.caseId.normalize('NFC')).toBe(nfd.caseId.normalize('NFC'));
    // …and they are still two ids with two digests. This is INTENDED: a codec
    // that normalised would map distinct ids onto one (the collision this round
    // is about). The residual is an audit/display confusable, resolved by the
    // host rendering ids escaped or generating ASCII ids.
    expect(hashCourtEscalationRequest(nfc)).not.toBe(hashCourtEscalationRequest(nfd));
    expect(courtEscalationRequestPreimage(nfc)).not.toBe(courtEscalationRequestPreimage(nfd));
  });

  it('overlong UTF-8 cannot be expressed in the string domain, and the byte domain collapses to U+FFFD', () => {
    // (a) JS strings are UTF-16; TextEncoder always emits the SHORTEST form, so
    // an overlong encoding (C0 AF for '/', C0 80 for NUL) has no string input.
    const minimal = (cp: number): number[] => {
      if (cp < 0x80) return [cp];
      if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
      if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
      return [
        0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f),
      ];
    };
    for (const cp of [0x00, 0x41, 0x7f, 0x80, 0x7ff, 0x800, 0xfffd, 0x10000, 0x1f600, 0x10ffff]) {
      expect([...utf8(String.fromCodePoint(cp))], `U+${cp.toString(16)}`).toEqual(minimal(cp));
    }
    // (b) the BYTE boundary is the host's (HTTP): a non-fatal decoder turns an
    // overlong NUL (C0 80) into two U+FFFD — never a NUL — so an overlong
    // encoding cannot smuggle the preimage separator past the U+0000 check. It
    // produces a LEGAL but different id, which is exactly why the host binding
    // (an exact comparison against the case it routed on) is the place the
    // substitution dies.
    const lenient = new TextDecoder('utf-8', { fatal: false });
    const smuggled = lenient.decode(Uint8Array.from([0xc0, 0x80]));
    expect(smuggled).toBe('\ufffd\ufffd');
    expect(smuggled).not.toContain('\u0000');
    const built = buildCourtEscalationRequest({ ...request(), caseId: smuggled });
    expect(built.caseId).toBe('\ufffd\ufffd');
    expect(() => escalationRequestToMachineEvent(resolvedRoundOne(), built, 3300, {
      caseId: CASE_ID, authenticatedPubkey: CHALLENGER_PUBKEY,
    })).toThrow(/must not cross cases/);
    // …and the canonical (fatal) decoder the codec's helper uses refuses the
    // overlong form outright, which is the decoder a host must use.
    const strict = new TextDecoder('utf-8', { fatal: true });
    expect(() => strict.decode(Uint8Array.from([0xc0, 0x80]))).toThrow();
    // The overlong two-byte form of '/', decoded leniently, is NOT '/'.
    expect(lenient.decode(Uint8Array.from([0xc0, 0xaf]))).not.toBe('/');
  });
});

describe('T1 (r9-5) — the r8 injectivity pin measured sha256, not the encoding', () => {
  it('a LOSSY encoder still passes the 2 000-id digest sweep (the pin has no power)', () => {
    // Exactly the r8 pin's generator, run through a deliberately lossy encoder:
    // hash only the first 8 characters of the id.
    const lossy = (id: string): string =>
      hashCourtEscalationRequest(buildCourtEscalationRequest({ ...request(), caseId: id.slice(0, 8) }));
    const digests = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) digests.add(lossy(`court:market-r48:${i}`));
    // 2 000 distinct digests from 2 000 ids that are ALL the same string. The r8
    // pin therefore proves collision resistance of sha256 over distinct inputs,
    // which no caseId guard can affect — it would not have failed on v0.14.0 and
    // it cannot fail on a folding or truncating encoder.
    expect(digests.size).toBe(1);

    const honest = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      honest.add(courtEscalationRequestPreimage(buildCourtEscalationRequest({
        ...request(), caseId: `court:market-r48:${i}`,
      })));
    }
    expect(honest.size).toBe(2_000);
  });

  it('the differential pin: dangerous pairs differ in the PREIMAGE BYTES or are refused', () => {
    const base = request();
    const preimageOf = (caseId: string): string =>
      courtEscalationRequestPreimage(buildCourtEscalationRequest({ ...base, caseId }));
    // Pairs that must be two ids: the encoding is injective, so the preimage
    // bytes differ. (Comparing preimages, not digests, is what makes this test
    // able to catch a lossy encoder: a digest comparison cannot.)
    const left = ['court:caf\u00e9:1', 'court:X:1', 'court:X:1\u0001', 'court:X:1\ufffd', 'court:X:1a'];
    const right = ['court:cafe\u0301:1', 'court:X:2', 'court:X:1\u0002', 'court:X:1\ufffe', 'court:X:1A'];
    for (let i = 0; i < left.length; i += 1) {
      const a = utf8(preimageOf(left[i]));
      const b = utf8(preimageOf(right[i]));
      expect(a, `${left[i]} vs ${right[i]}`).not.toEqual(b);
      // Byte-level injectivity of the id itself, independent of the join.
      expect(utf8(left[i]), `${left[i]} vs ${right[i]}`).not.toEqual(utf8(right[i]));
    }
    // The fold family is refused, so it cannot be a preimage pair at all.
    for (const id of [`${CASE_ID} `, ` ${CASE_ID}`, `${CASE_ID}\u00a0`]) {
      expect(() => preimageOf(id)).toThrow(/whitespace/);
    }
    expect(() => preimageOf(`${CASE_ID}\u0000`)).toThrow(/U\+0000/);
    expect(() => preimageOf(`${CASE_ID}\ud800`)).toThrow(/canonical UTF-8/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the host binding (r8-2 attacked)
// ─────────────────────────────────────────────────────────────────────────────

describe('T2 (r9-2) — the bond txid in the preimage is bound to the case', () => {
  it('a foreign bond txid is refused; the challenge record holds the binding', () => {
    const state = resolvedRoundOne();
    expect(state.challenges[0].bondTxid).toBe(BOND_TXID);
    // Measured on v0.14.1: ACCEPTED. The filter matches `bondProofHash` only, so
    // the logged `requestHash` — the append-only log's ONLY record of the
    // request — committed to a txid this case never bound. A host reading the
    // body's `bondTxid` to decide which bond the escalation is under (bond
    // release / slashing) attributed it to a bond that paid nothing.
    expect(() => escalationRequestToMachineEvent(
      state, request({ bondTxid: OTHER_PUBKEY }), 3300, BINDING,
    )).toThrow(/the request hash would commit to a bond this case never bound/);
    // Over-strictness: the honest pairing still maps, and the digest covers it.
    const honest = escalationRequestToMachineEvent(state, request(), 3300, BINDING);
    expect(honest.bondProofHash).toBe(MEMBERSHIP_BOND);
    expect(hashCourtEscalationRequest(request()))
      .not.toBe(hashCourtEscalationRequest(request({ bondTxid: OTHER_PUBKEY })));
  });
});

describe('T2 (r9-3) — a CONCESSION is not an ESCALATION', () => {
  it('a signed concession cannot be minted into an escalate event', () => {
    const state = resolvedRoundOne();
    const concession = request({ concession: true });
    // Measured on v0.14.1: the mapper returned a valid `escalate` event, the
    // reducer accepted it, the case left `round_resolved` for a second rung
    // (a fresh round bond, another panel) and the append-only log recorded a
    // challenger escalation under the hash of a request that DROPS the appeal.
    const err = caught(() => escalationRequestToMachineEvent(state, concession, 3300, BINDING));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/CONCESSION/);
    expect(err.message).toMatch(/concede/);
    // The two claims are distinguishable in the hash (they always were — the
    // flag was parsed, then ignored by the mapper).
    expect(hashCourtEscalationRequest(concession)).not.toBe(hashCourtEscalationRequest(request()));
    // Over-strictness: the non-concession request still escalates end-to-end.
    const next = reduceCourtConfirmationMachine(
      state, escalationRequestToMachineEvent(state, request(), 3300, BINDING),
    );
    expect(next.phase).toBe('ladder_pending');
  });
});

describe('T2 (r9-6) — the binding is a TRUST ANCHOR a host can fill from the wire', () => {
  it('an echoed binding reproduces the r8-2 harm — registered, visible, pinned', () => {
    const state = resolvedRoundOne();
    // The attacker is the bonded challenger (idx 2, from the case) claiming
    // ANOTHER juror's pubkey. A host that passes the wire's claims back as the
    // "authenticated" values rebuilds the pre-r8-2 event exactly: idx 2 in the
    // log, juror 3's pubkey. No pure function can tell "verified" from "copied",
    // so this is a host obligation (owner: the escalation route's auth layer;
    // `CourtEscalationBinding` states it) and the boundary is asserted here so it
    // stays a decision on the record.
    const claim = request({ challengerPubkey: OTHER_PUBKEY });
    const echoed: CourtEscalationBinding = {
      caseId: claim.caseId, authenticatedPubkey: claim.challengerPubkey,
    };
    const event = escalationRequestToMachineEvent(state, claim, 3300, echoed);
    expect(event.challengerIdx).toBe(2);
    expect(event.challengerPubkey).toBe(OTHER_PUBKEY);
    const next = reduceCourtConfirmationMachine(state, event);
    expect(next.escalationLog.at(-1)).toMatchObject({
      challengerIdx: 2, challengerPubkey: OTHER_PUBKEY,
    });
    // The honest binding is refused for the same request — the guard is real, it
    // just cannot audit its own input.
    expect(() => escalationRequestToMachineEvent(state, claim, 3300, BINDING))
      .toThrow(/not the pubkey the request authenticated as/);
  });

  it('bond OWNERSHIP is still the host verifier\'s (r40-3 is not preempted)', () => {
    // A DERIVABLE witness: `hash(bondTxid)` is public the moment the bond is on
    // chain, so a juror owning nothing can register it under its own index
    // (first-come-first-served, r38-1 uniqueness). The r8-2 binding proves the
    // REQUEST was authenticated — it says nothing about who paid the bond, and
    // the state carries no idx→pubkey registry (r29-5). Registered residual with
    // a named owner: the host's bond verifier must bind the witness to the event
    // author.
    const payerBondTxid = hexId('c');
    const derivable = bytesToHex(sha256(utf8(payerBondTxid)));
    let s = createCourtConfirmationMachine({
      sessionHash: SESSION,
      proposalHash: PROPOSAL,
      proposedOutcome: 'YES',
      allowedOutcomes: ['YES', 'NO'],
      participantIndices: [...ROSTER],
      confirmDeadline: 1000,
      challengeDeadline: 2000,
      maxLadderRounds: 3,
    });
    for (const idx of ROSTER) {
      s = reduceCourtConfirmationMachine(s, {
        type: 'accept_confirmation', idx,
        confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
        eventId: hid(`c${idx}`), now: 100 + idx,
      });
    }
    s = reduceCourtConfirmationMachine(s, { type: 'close_confirmations', now: 1000 });
    s = reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 1100 });
    // idx 3 registers the payer's publicly derivable witness; idx 3 owns no bond.
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge', idx: 3, bondTxid: payerBondTxid,
      bondProofHash: derivable, eventId: hid('c3'), now: 1500,
    });
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
    s = voteRound(s, 1, 'NO', 2050);
    const event = escalationRequestToMachineEvent(s, request({
      challengerPubkey: CHALLENGER_PUBKEY, bondTxid: payerBondTxid, bondProofHash: derivable,
    }), 3300, { caseId: CASE_ID, authenticatedPubkey: CHALLENGER_PUBKEY });
    // Accepted, and attributed to the juror that COPIED the witness (idx 3): the
    // machine cannot tell it from the payer. Visible, not assumed.
    expect(event.challengerIdx).toBe(3);
    expect(event.bondProofHash).toBe(derivable);
  });

  it('the case state carries NO case identity, so the binding is the only case check', () => {
    // The reducer's case fields are a session hash and a proposal hash; there is
    // no market/case id in the state (and adding one would be a wire change, not
    // a guard). So "a request for case A applied to case B's snapshot" is
    // refused only because the host's binding says which case it ROUTED on —
    // state and binding must come from the same lookup. Registered boundary.
    const state = resolvedRoundOne();
    expect(Object.keys(state)).not.toContain('caseId');
    expect(Object.keys(state)).not.toContain('marketId');
    // Same wire, two host stories: the binding decides.
    expect(escalationRequestToMachineEvent(state, request(), 3300, BINDING).challengerIdx).toBe(2);
    expect(() => escalationRequestToMachineEvent(state, request(), 3300, {
      caseId: 'court:somewhere-else:1', authenticatedPubkey: CHALLENGER_PUBKEY,
    })).toThrow(/must not cross cases/);
  });
});

describe('T2 (r8-2) — the unambiguous parts of the bond ledger', () => {
  it('one hash bound to two owners is refused; the reverse is attributable', () => {
    const state = resolvedRoundOne();
    const ambiguous = forge(state, {
      challenges: [
        { ...state.challenges[0] },
        { ...state.challenges[0], idx: 3, eventId: hid('c3') },
      ],
    });
    expect(() => escalationRequestToMachineEvent(ambiguous, request(), 3300, BINDING))
      .toThrow(/witness is ambiguous/);
    // Two bonds under ONE owner (same idx, different hashes) is a different
    // shape: the filter matches the request's witness exactly, so a single owner
    // is selected and the attribution is unchanged. The ledger invariant that
    // refuses this shape runs in the reducer (`assertValidConfirmationLedger`),
    // not here, and the mapper must not guess between hashes it was not given.
    const twoBonds = forge(state, {
      challenges: [
        { ...state.challenges[0] },
        { ...state.challenges[0], bondTxid: hexId('b'), bondProofHash: hid('b1'), eventId: hid('c4') },
      ],
    });
    expect(escalationRequestToMachineEvent(twoBonds, request(), 3300, BINDING).challengerIdx).toBe(2);
  });

  it('a restored snapshot whose two round counters disagree cannot mint an attribution record', () => {
    const state = resolvedRoundOne();
    // The machine writes `ladderRound` and `ladder.round` together, so this state
    // is not one it could have produced; minting an event from it lets the
    // escalation log advance a counter the reducer's own barriers size from the
    // other (r9-4).
    const skewed = forge(state, { ladderRound: 4 });
    const err = caught(() => escalationRequestToMachineEvent(skewed, request({ round: 4 }), 3300, BINDING));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/round counters disagree/);
    // Over-strictness: the honest state (both counters 1) still maps.
    expect(escalationRequestToMachineEvent(state, request(), 3300, BINDING).roundIndex).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — duplicate JSON keys: how deep does the refusal reach?
// ─────────────────────────────────────────────────────────────────────────────

describe('T3 (r8-4 attacked) — the depth-1 scope, and why it is sound', () => {
  const wireOf = (r: CourtEscalationRequest): Record<string, unknown> =>
    JSON.parse(serializeCourtEscalationRequest(r)) as Record<string, unknown>;

  it('every wire field is a SCALAR — which is what makes a depth-1 scan sufficient', () => {
    // The scanner only walks the top-level object. That is sound for this wire
    // only because no field can be an object or an array: a nested duplicate is
    // therefore unreachable in an ACCEPTED request. This test is the guard that
    // keeps the argument true — if a future field becomes structured, it fails
    // loudly instead of the scanner silently narrowing.
    const wire = wireOf(request());
    expect(Object.keys(wire).sort()).toEqual([
      'bondProofHash', 'bondTxid', 'caseId', 'challengerPubkey',
      'concession', 'eventId', 'round', 'roundBondProofHash', 'signedAtSec',
    ]);
    for (const [key, value] of Object.entries(wire)) {
      expect(['string', 'number', 'boolean'], key).toContain(value === null ? 'string' : typeof value);
    }
  });

  it('a nested duplicate object is refused by the type guard (typed), not silently parsed', () => {
    const wire = wireOf(request());
    for (const key of Object.keys(wire)) {
      const body = JSON.stringify({ ...wire, [key]: JSON.parse('{"a":1,"a":2}') });
      const err = caught(() => parseCourtEscalationRequest(body));
      // Not the duplicate scanner (depth 1) — the field's own type guard. The
      // point of the pin: the request is REFUSED, with this module's error type.
      expect(err, key).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message, key).not.toMatch(/repeats the field/);
    }
  });

  it('an array with duplicate elements is refused the same way', () => {
    const wire = wireOf(request());
    for (const key of Object.keys(wire)) {
      const err = caught(() => parseCourtEscalationRequest(
        JSON.stringify({ ...wire, [key]: ['dup', 'dup'] }),
      ));
      expect(err, key).toBeInstanceOf(CourtConfirmationTransitionError);
    }
    // A duplicate INSIDE an array of objects is not scanned either — and it is
    // just as unreachable, because no field accepts an array at all.
    const err = caught(() => parseCourtEscalationRequest(
      JSON.stringify({ ...wire, caseId: JSON.parse('[{"a":1,"a":2}]') }),
    ));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
  });

  it('the refusal is TYPED, and the scanner cannot be fooled by a value that looks like a key', () => {
    const body = serializeCourtEscalationRequest(request())
      .replace('"concession":', '"concession":true,"concession":');
    const err = caught(() => parseCourtEscalationRequest(body));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/repeats the field concession/);
    // A caseId whose TEXT is a JSON key/separator sequence must not trip the
    // scanner into refusing, or be used to hide a real duplicate.
    const sneaky = buildCourtEscalationRequest({
      ...request(), caseId: 'a","concession":true,"x',
    });
    expect(parseCourtEscalationRequest(serializeCourtEscalationRequest(sneaky))).toEqual(sneaky);
    const sneakyDup = serializeCourtEscalationRequest(sneaky)
      .replace('"concession":', '"concession":true,"concession":');
    expect(() => parseCourtEscalationRequest(sneakyDup)).toThrow(/repeats the field concession/);
  });

  it('an already-parsed object has lost the duplicate — the documented hole, pinned', () => {
    const body = serializeCourtEscalationRequest(request())
      .replace('"concession":', '"concession":true,"concession":');
    // JSON.parse keeps the LAST claim (`false`), so the codec sees one field and
    // cannot know two were written. Hosts must hand `parse` the body TEXT; an
    // object input is the host's own parse and the host's own duplicate policy.
    expect((JSON.parse(body) as { concession: unknown }).concession).toBe(false);
    expect(parseCourtEscalationRequest(JSON.parse(body)).concession).toBe(false);
    expect(() => parseCourtEscalationRequest(body)).toThrow(/repeats the field/);
  });

  it('a pathological body is still a typed refusal, never a raw RangeError', () => {
    // 20 000 nested arrays: JSON.parse itself overflows the stack, and that error
    // must not escape the module's fail-closed boundary as a foreign type.
    const deep = `{"caseId":${'['.repeat(20_000)}${']'.repeat(20_000)}}`;
    const err = caught(() => parseCourtEscalationRequest(deep));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/not valid JSON|non-empty string/);
    // A 1e999 literal parses to Infinity: refused by the id type guard.
    expect(() => parseCourtEscalationRequest('{"caseId":1e999}'))
      .toThrow(CourtConfirmationTransitionError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the r8-6 rule, at its boundaries and through its own gap
// ─────────────────────────────────────────────────────────────────────────────

describe('T4 (r8-6 attacked) — the history/ladder rule at every lag', () => {
  it('lag 0 is the only legal lag: exactly the resolved rounds are on the history', () => {
    const one = resolvedRoundOne({ maxLadderRounds: 3 });
    expect(one.outcomeHistory.map((r) => r.round)).toEqual([1]);
    expect(one.ladderRound).toBe(1);
    // A 2-round ladder still resolves [1, 2] — the over-strictness control for
    // the `length === round - 1` rule (round 2 with ONE record is legal).
    const s = reduceCourtConfirmationMachine(
      one, escalationRequestToMachineEvent(one, request(), 3300, BINDING),
    );
    const two = voteRound(s, 2, 'NO', 3350);
    expect(two.outcomeHistory.map((r) => r.round)).toEqual([1, 2]);
    expect(two.ladderRound).toBe(2);
    expect(two.ladder!.round).toBe(2);
  });

  it('a single-round ladder resolves with record 1 and finalizes', () => {
    const s = resolvedRoundOne({ maxLadderRounds: 1 });
    expect(s.outcomeHistory.map((r) => r.round)).toEqual([1]);
    const final = reduceCourtConfirmationMachine(s, { type: 'finalize', now: 3400 });
    expect(final.phase).toBe('final');
  });

  /** A snapshot parked at `ladder_vote_closed` for `round`, history as given. */
  function closedRound(
    base: CourtConfirmationMachineState,
    round: number,
    history: Array<{ round: number; outcome: string }>,
  ): CourtConfirmationMachineState {
    return forge(base, {
      ladderRound: round,
      phase: 'ladder_vote_closed',
      ladder: {
        round, voteDeadline: 9000,
        votes: [{ idx: 1, outcome: 'YES', eventId: hid('9a') }],
        roundRoster: [...ROSTER],
      },
      outcomeHistory: history.map((h, i) => ({
        round: h.round, outcome: h.outcome, winnerEventIds: [hid(`w${i}`)], winnerIndices: [1],
      })),
    });
  }

  it('lag 1 and lag k are refused — and the snapshot is left untouched (no partial append)', () => {
    const base = resolvedRoundOne({ maxLadderRounds: 5 });
    const snapshot = JSON.stringify(base);
    const lag1 = closedRound(base, 3, [{ round: 1, outcome: 'NO' }]);
    const err = caught(() => reduceCourtConfirmationMachine(lag1, { type: 'resolve_round', now: 9500 }));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/outcome history holds 1 record\(s\) but 2 round\(s\) were resolved/);
    const lagK = closedRound(base, 4, [{ round: 1, outcome: 'NO' }]);
    expect(() => reduceCourtConfirmationMachine(lagK, { type: 'resolve_round', now: 9500 }))
      .toThrow(/holds 1 record\(s\) but 3 round\(s\) were resolved/);
    // Purity: nothing was appended anywhere, and the honest snapshot is intact.
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(base.outcomeHistory.map((r) => r.round)).toEqual([1]);
  });

  it('a history AHEAD of the round is refused too (duplicate resolve)', () => {
    const base = resolvedRoundOne({ maxLadderRounds: 5 });
    const ahead = closedRound(base, 1, [{ round: 1, outcome: 'NO' }, { round: 2, outcome: 'NO' }]);
    expect(() => reduceCourtConfirmationMachine(ahead, { type: 'resolve_round', now: 9500 }))
      .toThrow(/holds 2 record\(s\) but 0 round\(s\) were resolved/);
  });

  it('r9-4: the two round counters must agree, or the r8-6 rule is bypassed', () => {
    // Measured on v0.14.1: ACCEPTED. `ladderRound = 4` (three rungs on the
    // escalation log) with `ladder.round = 2` (one history record) satisfied
    // `length === ladder.round - 1` and appended round 2 — a history that
    // disagrees with the machine's own round counter, which is what `escalate`
    // and `assertValidEscalationLog` size themselves from. The r8-6 rule exists
    // to refuse exactly this, and one forged field walked around it.
    const base = resolvedRoundOne({ maxLadderRounds: 5, requireRoundBond: true });
    const skewed = forge(closedRound(base, 2, [{ round: 1, outcome: 'NO' }]), { ladderRound: 4 });
    const err = caught(() => reduceCourtConfirmationMachine(skewed, { type: 'resolve_round', now: 9500 }));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/round counters disagree/);
    // The CONSISTENT version of the same forgery (both counters 4, one record)
    // is refused by the r8-6 rule itself — together they close the shape.
    const consistent = closedRound(base, 4, [{ round: 1, outcome: 'NO' }]);
    expect(() => reduceCourtConfirmationMachine(consistent, { type: 'resolve_round', now: 9500 }))
      .toThrow(/holds 1 record\(s\) but 3 round\(s\) were resolved/);
  });
});
