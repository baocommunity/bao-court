// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Review round 11 — attacking the round-10 fixes and the new exact bound
 * (v0.15.0, `fe47ba4`).
 *
 * Round 10 fixed three things by *escaping, binding and barrier-ing*: the echo
 * path (r10-1 `quoteWireValue`), the signed-content binding (r10-3
 * `escalationRequestBindingFromSignedEvent`), and the ladder counter invariant
 * (r10-4 `assertRoundCountersAgree`). Round 11 attacks those fixes as code, and
 * attacks the new exact bound (R52) as arithmetic.
 *
 * Findings (`docs/REVIEW_ROUND_11.md` has the repro + disposition):
 *
 *   T1  r10-1's escape was not TOTAL and its bound was not the bound it
 *       documented: three sites still echoed a wire/snapshot value verbatim
 *       (`event.kind` on the new binder, `state.ladderRound` / `state.phase` on
 *       a restored snapshot), the 64-character budget was spent on the INPUT (a
 *       legal 60-character format-character id produced a 387-character echo),
 *       and a hostile value OBJECT made the refusal itself throw a raw
 *       `TypeError` (FIXED);
 *   T2  r10-3's binding is sound against field flips, extra fields, reordering,
 *       re-escaping, kind-swaps and the Nirvana class — but the new entry called
 *       `verifyEvent` on an unvalidated event, so `tags: null` escaped as
 *       `Cannot read properties of null (reading 'map')` (FIXED);
 *   T3  no verdict path can index out of bounds (history shorter/longer is
 *       caught by `record.round !== ladder.round`), but `flag_clawback` — the one
 *       reader the r10-4 sweep missed — persisted `ladderRound` on a skewed
 *       snapshot (FIXED);
 *   T4  the exact bound holds at the boundary, the clamp is applied after the
 *       comparison, and no parameter can overflow the scan (BLOCKED) — but the
 *       parameters are rationalised from `String(number)`, so an economy
 *       expressed by ARITHMETIC (`beta: 3 * 0.1`) is a different rational from
 *       `beta: 0.3` and admits one round more at the exact boundary (r11-5,
 *       PARTIAL → doc claim narrowed, visible boundary pinned, DEFERRED because
 *       accepting decimal text would preempt the `a_f as a string` pin).
 */

import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import {
  MAX_ESCALATION_CASE_ID_BYTES,
  buildCourtEscalationRequest,
  courtEscalationRequestSignedContent,
  escalationRequestBindingFromSignedEvent,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
  type CourtEscalationRequest,
  type CourtEscalationRequestEvent,
} from '../courtEscalationRequest';
import {
  CourtConfirmationTransitionError,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../courtConfirmationMachine';
import { MAX_LADDER_ROUNDS } from '../confirmationMachineCore';
import { budgetMs, testTimeoutFor } from './helpers/budget';
import {
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  escalationOptionEv,
  ladderCapWithinBound,
  type LadderParameters,
} from '../ladderEconomics';

/**
 * Watchdog for the exact-bound scan (r11-4). Derived and env-overridable —
 * never a literal 5 s performance pin: `LADDER_SCAN_BUDGET_MS=60000 npm test`
 * raises it on a loaded box without editing this file.
 */
const SCAN_BUDGET_MS = budgetMs('LADDER_SCAN_BUDGET_MS');

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
const CASE_ID = 'court:market-r50:1';
const ROUND_BOND = hid('a2');
const OTHER_PUBKEY = hexId('9');

const BINDING = { caseId: CASE_ID, authenticatedPubkey: CHALLENGER_PUBKEY };

/** Characters a log line must never carry verbatim. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

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

function challengeWindow(): CourtConfirmationMachineState {
  let s = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: ['YES', 'NO'],
    participantIndices: [...ROSTER],
    confirmDeadline: 1000,
    challengeDeadline: 2000,
    maxLadderRounds: 3,
    requireRoundBond: true,
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
  return reduceCourtConfirmationMachine(s, { type: 'open_challenge_window', now: 1100 });
}

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

/** A challenged case in `round_resolved` after round 1 resolves `NO`. */
function resolvedRoundOne(): CourtConfirmationMachineState {
  let s = challengeWindow();
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

/** The honest three-round ladder: rounds 1/2/3 resolve NO / YES / NO. */
function threeRoundLadder(): CourtConfirmationMachineState {
  let s = resolvedRoundOne();
  s = reduceCourtConfirmationMachine(s, {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: 2,
    challengerPubkey: CHALLENGER_PUBKEY,
    requestHash: hid('r2'),
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: hid('b2'),
    roundIndex: 2,
    now: 3300,
  });
  s = voteRound(s, 2, 'YES', 3400);
  s = reduceCourtConfirmationMachine(s, {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: 2,
    challengerPubkey: CHALLENGER_PUBKEY,
    requestHash: hid('r3'),
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: hid('b3'),
    roundIndex: 3,
    now: 4600,
  });
  return voteRound(s, 3, 'NO', 4700);
}

const forge = (
  state: CourtConfirmationMachineState,
  over: Record<string, unknown>,
): CourtConfirmationMachineState =>
  JSON.parse(JSON.stringify({ ...state, ...over })) as CourtConfirmationMachineState;

function caught(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal, got none');
}

/** The value a refusal quotes between `open` and `close` (the echo). */
function echoOf(message: string, open: string, close: string): string {
  const at = message.indexOf(open);
  if (at < 0) return '';
  const rest = message.slice(at + open.length);
  const end = rest.indexOf(close);
  return end < 0 ? rest : rest.slice(0, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — r10-1's escape path (attacked as code)
// ─────────────────────────────────────────────────────────────────────────────
describe('T1 (r10-1 attacked) — the echo path must be TOTAL and its bound real', () => {
  it('r11-1: the budget is spent on the ESCAPED output, not on the input', () => {
    // MEASURED ON fe47ba4: `quoteWireValue` clipped the INPUT to 64 code points
    // and THEN escaped, so a LEGAL id made of 60 zero-width spaces (180 bytes —
    // inside the 256-byte bound, interior so `trim` never sees them) produced a
    // 387-character echo inside a 498-character message, and the doc claimed a
    // 64-character bound.
    const state = resolvedRoundOne();
    const cfId = `${CASE_ID}${'\u200b'.repeat(60)}`;
    const err = caught(() => escalationRequestToMachineEvent(
      state, request({ caseId: cfId }), 3300, BINDING,
    ));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).not.toMatch(UNSAFE);
    const echo = echoOf(err.message, 'names case "', '" but');
    // Bounded by the budget in ESCAPED characters, plus the ellipsis marker.
    expect(echo.length).toBeLessThanOrEqual(65);
    expect(echo.endsWith('…')).toBe(true);
    // The escaped unit survives, so the marker is a clip and not a re-encoding.
    expect(echo.includes('\\u{200b}')).toBe(true);
    // The whole message stays a log line, not a log flood.
    expect(err.message.length).toBeLessThan(200);
    // …and the same id still maps when it is not being echoed (over-strictness
    // control: the guard must not have started refusing format characters).
    expect(hashCourtEscalationRequest(request({ caseId: cfId }))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('r11-1: every refusal that echoes a wire or snapshot value escapes it', () => {
    // The round-10 claim was "all four echo sites use it". There were seven. The
    // sweep is the pin: each entry below puts a newline behind a value the
    // caller does not control, and each message must come back as ONE line.
    const state = resolvedRoundOne();
    const hostile = '2\nESCALATION ACCEPTED for case court:target:1';
    const sites: ReadonlyArray<readonly [string, () => string]> = [
      ['cross-case id', () => caught(() => escalationRequestToMachineEvent(
        state, request({ caseId: `court:A${hostile}` }), 3300, BINDING,
      )).message],
      ['host-bound id', () => caught(() => escalationRequestToMachineEvent(
        state, request(), 3300, { caseId: `court:A${hostile}`, authenticatedPubkey: CHALLENGER_PUBKEY },
      )).message],
      ['round value', () => caught(() => buildCourtEscalationRequest({
        ...request(), round: hostile as unknown as number,
      })).message],
      ['unknown field', () => caught(() => parse(`{"caseId":"x","a\\nb":${JSON.stringify(hostile)}}`)).message],
      ['repeated field', () => caught(() => parse(
        `{"a\\nb":1,"a\\nb":2,"caseId":${JSON.stringify(CASE_ID)}}`,
      )).message],
      ['event kind (wire)', () => caught(() => escalationRequestBindingFromSignedEvent(
        request(), fakeEvent({ kind: hostile }), 39009,
      )).message],
      ['ladderRound (snapshot)', () => caught(() => escalationRequestToMachineEvent(
        forge(state, { ladderRound: hostile }), request(), 3300, BINDING,
      )).message],
      ['ladder.round (snapshot)', () => caught(() => escalationRequestToMachineEvent(
        forge(state, { ladderRound: 1, ladder: { ...state.ladder!, round: hostile } }),
        request(), 3300, BINDING,
      )).message],
      ['phase (snapshot)', () => caught(() => escalationRequestToMachineEvent(
        forge(state, { phase: `challenge_window${hostile}`, ladder: undefined }), request(), 3300, BINDING,
      )).message],
      ['assertRoundCountersAgree', () => caught(() => reduceCourtConfirmationMachine(
        forge(threeRoundLadder(), { ladderRound: hostile }),
        { type: 'flag_clawback', idx: 1, reason: 'late', now: 7000 },
      )).message],
    ];
    for (const [label, message] of sites) {
      const text = message();
      expect(text, label).not.toMatch(UNSAFE);
      expect(text, label).toMatch(/\\u\{a\}|<not an integer>/);
    }
  });

  it('r11-1: terminal escape sequences cannot reach a terminal', () => {
    // ANSI/OSC are `Cc`-introduced (`ESC` U+001B, `BEL` U+0007, C1 `CSI`
    // U+009B), so the same class escapes them — pinned because a credible
    // reviewer will ask whether Cf-adjacent sequences are covered.
    const state = resolvedRoundOne();
    const sequences = [
      '\u001b]0;pwned\u0007',                      // OSC 0: window title
      '\u001b]8;;https://evil.example\u001b\\',    // OSC 8: hyperlink
      '\u009b31mred\u009b0m',                      // C1 CSI colour
      '\u001b[2J\u001b[H',                         // clear screen
    ];
    for (const sequence of sequences) {
      const err = caught(() => escalationRequestToMachineEvent(
        state, request({ caseId: `court:A${sequence}` }), 3300, BINDING,
      ));
      expect(err.message, JSON.stringify(sequence)).not.toMatch(UNSAFE);
      // The introducer itself is escaped (ESC, or C1 CSI), so the terminal never
      // sees a sequence at all.
      const introducer = [...sequence].find((ch) => UNSAFE.test(ch)) ?? '';
      expect(err.message, JSON.stringify(sequence))
        .toContain(`\\u{${(introducer.codePointAt(0) ?? 0).toString(16)}}`);
    }
  });

  it('r11-1: a hostile value OBJECT is described, never stringified', () => {
    // MEASURED ON fe47ba4: the refusal at the `round` site built its message
    // with `String(roundRaw)`, so `Object.create(null)` escaped as
    // `TypeError: Cannot convert object to primitive value` — a foreign error
    // type at the typed-only boundary (r3-1/r41-1/r49-d) — and a `toString` that
    // throws ran caller code inside a refusal.
    const hostileObject = Object.create(null) as unknown;
    const throwing = { toString() { throw new Error('boom'); } } as unknown;
    for (const value of [hostileObject, throwing, Symbol('s') as unknown, 10n as unknown]) {
      const err = caught(() => buildCourtEscalationRequest({ ...request(), round: value as number }));
      expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message).toContain('must be an integer in 1..5');
      expect(err.message).not.toContain('boom');
    }
    // The binder's own echo sites are total for the same reason.
    const kindErr = caught(() => escalationRequestBindingFromSignedEvent(
      request(), fakeEvent({ kind: hostileObject }), 39009,
    ));
    expect(kindErr).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(kindErr.message).toContain('<object>');
  });

  it('r11-1: the clip is a PREFIX of the escaped value, never a split unit', () => {
    // Walking by code point means the clip cannot split a surrogate pair into
    // two lone surrogates, and clipping between (never inside) escape sequences
    // means no `\u{20` fragment can look like a valid escape.
    const state = resolvedRoundOne();
    const escaped = (value: string): string =>
      [...value].map((ch) => (UNSAFE.test(ch)
        ? `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`
        : ch)).join('');
    const ids = [
      `${'a'.repeat(63)}\u{1F600}`,             // astral char on the boundary
      `${'b'.repeat(60)}${'\u200b'.repeat(4)}`, // escapes on the boundary
      `${'\u2066'.repeat(20)}`,                 // 8-char escapes only
    ];
    for (const caseId of ids) {
      const err = caught(() => escalationRequestToMachineEvent(
        state, request({ caseId }), 3300, BINDING,
      ));
      const echo = echoOf(err.message, 'names case "', '" but');
      expect(echo, caseId).not.toMatch(/\p{Cs}/u);
      // Every opening `\u{` has a closing `}`: no truncated escape.
      const opens = (echo.match(/\\u\{/g) ?? []).length;
      const complete = (echo.match(/\\u\{[0-9a-f]+\}/g) ?? []).length;
      expect(opens, caseId).toBe(complete);
      expect(escaped(caseId).startsWith(echo.replace(/…$/, '')), caseId).toBe(true);
    }
    // A 256-byte id still cannot double into a 512-byte entry (r10-1's claim,
    // now true for the escaped output as well).
    const longErr = caught(() => escalationRequestToMachineEvent(
      state, request({ caseId: 'a'.repeat(MAX_ESCALATION_CASE_ID_BYTES) }), 3300, BINDING,
    ));
    expect(longErr.message.length).toBeLessThan(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — r10-3's signed-content binding (attacked as an API)
// ─────────────────────────────────────────────────────────────────────────────

/** A shape-valid, signature-INVALID event: the shape pins never reach crypto. */
function fakeEvent(over: Record<string, unknown> = {}): CourtEscalationRequestEvent {
  return {
    kind: 39009,
    pubkey: CHALLENGER_PUBKEY,
    created_at: 1_790_000_000,
    tags: [],
    content: '{}',
    id: EVENT_ID,
    sig: 'a'.repeat(128),
    ...over,
  } as CourtEscalationRequestEvent;
}

const SECRET = generateSecretKey();
const CHALLENGER = getPublicKey(SECRET);

/** Sign `content` at `created_at`, then return the matching request + event. */
function signedPair(content: string, over: Partial<CourtEscalationRequest> = {}): {
  signed: CourtEscalationRequestEvent;
  bound: CourtEscalationRequest;
} {
  const base = request({ challengerPubkey: CHALLENGER, eventId: hexId('0'), ...over });
  const signed = finalizeEvent({
    kind: 39009, created_at: base.signedAtSec, tags: [], content,
  }, SECRET) as unknown as CourtEscalationRequestEvent;
  return { signed, bound: buildCourtEscalationRequest({ ...base, eventId: signed.id }) };
}

/** The CODEC's parser — the entry the wire body actually reaches. */
function parse(raw: string): CourtEscalationRequest {
  return parseCourtEscalationRequest(raw);
}

describe('T2 (r10-3 attacked) — what the signature covers, and what the shape costs', () => {
  it('r11-2: a malformed event SHAPE is a typed refusal, not a raw TypeError', () => {
    // MEASURED ON fe47ba4: the binder checked `isRecord(event)` and then called
    // `verifyEvent` on a rebuilt object — but the REBUILD iterates `tags`, so
    // `tags: null` escaped as `TypeError: Cannot read properties of null
    // (reading 'map')` and `tags: [null]` as `TypeError: tag is not iterable`.
    const malformed: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['tags null', { tags: null }],
      ['tags string', { tags: 'ab' }],
      ['tag null', { tags: [null] }],
      ['tag number', { tags: [[1]] }],
      ['id number', { id: 42 }],
      ['id short', { id: 'ab' }],
      ['pubkey short', { pubkey: 'abc' }],
      ['sig short', { sig: 'aabbcc' }],
      ['sig non-hex', { sig: 'z'.repeat(128) }],
      ['created_at string', { created_at: '1' }],
      ['created_at negative', { created_at: -1 }],
      ['content null', { content: null }],
      ['content object', { content: {} }],
    ];
    for (const [label, over] of malformed) {
      const err = caught(() => escalationRequestBindingFromSignedEvent(
        request(), fakeEvent(over), 39009,
      ));
      expect(err.constructor.name, label).toBe('CourtConfirmationTransitionError');
      expect(err, label).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message, label).toMatch(/escalation request event/);
    }
    // Over-strictness control: a shape-VALID event still reaches the signature
    // check (and is refused there, for the right reason).
    const sigErr = caught(() => escalationRequestBindingFromSignedEvent(request(), fakeEvent(), 39009));
    expect(sigErr.message).toMatch(/signature does not verify/);
  });

  it('r11-2: the signed content is byte-exact — extra, reordered and re-escaped bytes are refused', () => {
    const canonical = courtEscalationRequestSignedContent(
      request({ challengerPubkey: CHALLENGER, eventId: hexId('0') }),
    );
    // (a) an extra field smuggled INSIDE the signed JSON
    const extra = signedPair(JSON.stringify({ ...JSON.parse(canonical), bonus: 'drop-the-appeal' }));
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      extra.bound, extra.signed, 39009,
    )).message).toMatch(/not the canonical serialization/);
    // (b) the SAME fields in another ORDER (one semantic value, two byte strings)
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const { concession, ...rest } = parsed;
    const reordered = signedPair(`{"concession":${String(concession)},${JSON.stringify(rest).slice(1)}`);
    expect(JSON.parse(reordered.signed.content)).toEqual(parsed);
    expect(reordered.signed.content).not.toBe(canonical);
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      reordered.bound, reordered.signed, 39009,
    )).message).toMatch(/not the canonical serialization/);
    // (c) the same value spelled with a JSON unicode ESCAPE (`\u0065` for `e`)
    const reescaped = signedPair(canonical.replace('market', 'mark\\u0065t'));
    expect(JSON.parse(reescaped.signed.content).caseId).toBe(CASE_ID);
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      reescaped.bound, reescaped.signed, 39009,
    )).message).toMatch(/not the canonical serialization/);
    // …and the canonical pair binds in both directions (the control).
    const honest = signedPair(canonical);
    expect(escalationRequestBindingFromSignedEvent(honest.bound, honest.signed, 39009))
      .toEqual({ caseId: CASE_ID, authenticatedPubkey: CHALLENGER });
  });

  it('r11-2: the Nirvana class — a valid signature over OTHER bytes binds nothing', () => {
    const canonical = courtEscalationRequestSignedContent(
      request({ challengerPubkey: CHALLENGER, eventId: hexId('0') }),
    );
    const honest = signedPair(canonical);
    const other = signedPair(canonical.replace('"round":1', '"round":2'));
    expect(other.signed.id).not.toBe(honest.signed.id);
    // (a) the honest id with another event's bytes
    expect(() => escalationRequestBindingFromSignedEvent(honest.bound, other.signed, 39009))
      .toThrow(CourtConfirmationTransitionError);
    // (b) a VALID signature, transplanted onto the honest id: the sig covers the
    // id, so this is the "verifies but was produced over a different event"
    // shape — refused, and refused by the SIGNATURE, not by a field compare.
    const transplanted = { ...honest.signed, sig: other.signed.sig };
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      honest.bound, transplanted, 39009,
    )).message).toMatch(/signature does not verify/);
    // (c) the id recomputed for another KIND: kind is inside the id, so a request
    // signed for a concession event is not an escalation claim (r10-3's rule).
    const otherKind = finalizeEvent({
      kind: 39008, created_at: honest.bound.signedAtSec, tags: [], content: canonical,
    }, SECRET) as unknown as CourtEscalationRequestEvent;
    const otherKindBound = buildCourtEscalationRequest({ ...honest.bound, eventId: otherKind.id });
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      otherKindBound, otherKind, 39009,
    )).message).toMatch(/signed for another kind/);
    expect(() => escalationRequestBindingFromSignedEvent(otherKindBound, otherKind, 39008)).not.toThrow();
  });

  it('r11-2: the kind must be a NUMBER, and the refusal says so honestly', () => {
    // A numeric-string kind used to fall through to the "has kind 39009" message
    // — a diagnostic that read as if the kinds matched while the value was a
    // string, and a channel for a newline when the string was hostile.
    const signed = signedPair(courtEscalationRequestSignedContent(
      request({ challengerPubkey: CHALLENGER, eventId: hexId('0') }),
    ));
    for (const kind of ['39009', 39009.5, -1, Number.NaN]) {
      const err = caught(() => escalationRequestBindingFromSignedEvent(
        signed.bound, { ...signed.signed, kind } as unknown as CourtEscalationRequestEvent, 39009,
      ));
      expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message).toMatch(/kind must be a non-negative safe integer/);
    }
    const hostile = caught(() => escalationRequestBindingFromSignedEvent(
      signed.bound, { ...signed.signed, kind: '39009\nACCEPTED' } as unknown as CourtEscalationRequestEvent, 39009,
    ));
    expect(hostile.message).not.toMatch(UNSAFE);
    expect(hostile.message).toContain('\\u{a}');
  });

  it('r11-2: no field of the request lives outside the signed bytes', () => {
    // Totality, field by field: each of the eight wire fields is inside
    // `content`, so retyping it while keeping the signed event must refuse. The
    // structural half (each name really is in the preimage text) is asserted
    // too, so this cannot pass by all eight refusing for one shared reason.
    const canonical = courtEscalationRequestSignedContent(
      request({ challengerPubkey: CHALLENGER, eventId: hexId('0') }),
    );
    for (const field of [
      'caseId', 'round', 'challengerPubkey', 'bondTxid',
      'bondProofHash', 'roundBondProofHash', 'signedAtSec', 'concession',
    ]) {
      expect(canonical, field).toContain(`"${field}":`);
    }
    expect(canonical).not.toContain('eventId');
    const { signed, bound } = signedPair(canonical);
    const flips: ReadonlyArray<readonly [string, Partial<CourtEscalationRequest>]> = [
      ['caseId', { caseId: 'court:other:1' }],
      ['round', { round: 2 }],
      ['challengerPubkey', { challengerPubkey: OTHER_PUBKEY }],
      ['bondTxid', { bondTxid: hexId('c') }],
      ['bondProofHash', { bondProofHash: hexId('b') }],
      ['roundBondProofHash', { roundBondProofHash: null }],
      ['signedAtSec', { signedAtSec: bound.signedAtSec + 1 }],
      ['concession', { concession: true }],
    ];
    for (const [field, over] of flips) {
      const retyped = buildCourtEscalationRequest({ ...bound, ...over });
      expect(() => escalationRequestBindingFromSignedEvent(retyped, signed, 39009), field).toThrow();
    }
    expect(() => escalationRequestBindingFromSignedEvent(bound, signed, 39009)).not.toThrow();
  });

  it('r11-2: tags are signed but carry no wire claim (stated residual)', () => {
    // The binder does not constrain `tags`: no field of the request is expressed
    // there, so a tag cannot smuggle a claim — but it is also not part of any
    // refusal, and a host that routes on tags is reading its own convention.
    // Pinned so the boundary is a decision on the record.
    const canonical = courtEscalationRequestSignedContent(
      request({ challengerPubkey: CHALLENGER, eventId: hexId('0') }),
    );
    const tagged = finalizeEvent({
      kind: 39009, created_at: 1_790_000_000,
      tags: [['t', 'concession'], ['e', hexId('f')], ['x', 'not a claim']],
      content: canonical,
    }, SECRET) as unknown as CourtEscalationRequestEvent;
    const bound = buildCourtEscalationRequest({ ...request({ challengerPubkey: CHALLENGER }), eventId: tagged.id });
    expect(escalationRequestBindingFromSignedEvent(bound, tagged, 39009).caseId).toBe(CASE_ID);
    // Mutating the tags after signing breaks the id, so they ARE inside the
    // signed bytes — they just do not mean anything to this wire.
    const retagged = { ...tagged, tags: [['t', 'escalation']] };
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      bound, retagged, 39009,
    )).message).toMatch(/signature does not verify/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — r10-4's counter barrier, swept over every reader
// ─────────────────────────────────────────────────────────────────────────────

describe('T3 (r10-4 attacked) — the counters, the history, and every reader', () => {
  it('r11-3: counters that agree cannot hide a history of the wrong length', () => {
    const ladder = threeRoundLadder();
    expect([ladder.ladderRound, ladder.ladder?.round]).toEqual([3, 3]);
    expect(ladder.outcomeHistory.map((r) => r.round)).toEqual([1, 2, 3]);
    // Counters equal, history SHORTER: the last record names round 2 while the
    // ladder says 3 — refused, and refused BEFORE any index is read.
    const short = forge(ladder, { outcomeHistory: ladder.outcomeHistory.slice(0, -1) });
    const shortErr = caught(() => reduceCourtConfirmationMachine(short, { type: 'finalize', now: 6000 }));
    expect(shortErr).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(shortErr.message).toMatch(/last resolved round is 2 but the ladder is at round\s*3/);
    // Counters equal, history LONGER (a forged extra record): same rule.
    const long = forge(ladder, {
      outcomeHistory: [...ladder.outcomeHistory, { ...ladder.outcomeHistory[2], round: 4 }],
    });
    expect(caught(() => reduceCourtConfirmationMachine(
      long, { type: 'finalize', now: 6000 },
    )).message).toMatch(/last resolved round is 4/);
    // The honest snapshot still finalizes ROUND 3's NO (the control).
    const final = reduceCourtConfirmationMachine(ladder, { type: 'finalize', now: 6000 });
    expect(final.phase).toBe('final');
    expect(final.verdict?.outcome).toBe('NO');
  });

  it('r11-3: no verdict path can index out of bounds or read a stale record', () => {
    const ladder = threeRoundLadder();
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['empty history', { outcomeHistory: [] }],
      ['gapped history', { outcomeHistory: [ladder.outcomeHistory[0], ladder.outcomeHistory[2]] }],
      ['record for round 9', {
        outcomeHistory: [{ ...ladder.outcomeHistory[2], round: 9 }],
      }],
      ['record without winners', {
        outcomeHistory: [{ ...ladder.outcomeHistory[2], winnerEventIds: [] }],
      }],
    ];
    for (const [label, over] of cases) {
      const err = caught(() => reduceCourtConfirmationMachine(
        forge(ladder, over), { type: 'finalize', now: 6000 },
      ));
      expect(err, label).toBeInstanceOf(CourtConfirmationTransitionError);
      // Never a raw RangeError/TypeError from an index read.
      expect(err.constructor.name, label).toBe('CourtConfirmationTransitionError');
    }
  });

  it('r11-3: the sweep — flag_clawback was the one reader outside the barrier', () => {
    // r10-4 enumerated the readers of the two counters; `flag_clawback` was not
    // on the list, and it stamps `state.ladderRound` into a persisted record.
    // MEASURED ON fe47ba4: on a snapshot with `ladderRound 3` / `ladder.round 2`
    // it was ACCEPTED and wrote `{ reason: "late fee", round: 3 }` — a round-3
    // clawback on a case whose ladder says round 2.
    const ladder = threeRoundLadder();
    const skew = forge(ladder, { ladder: { ...ladder.ladder!, round: 2 } });
    const err = caught(() => reduceCourtConfirmationMachine(
      skew, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
    ));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/round counters disagree/);
    // The honest case is untouched, and the flag names the round the ladder is
    // actually on (over-strictness control: the barrier must not refuse flags).
    const flagged = reduceCourtConfirmationMachine(
      ladder, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
    );
    expect(flagged.clawbackFlags.filter((f) => f.reason === 'late fee'))
      .toEqual([{ idx: 1, reason: 'late fee', round: 3 }]);
  });

  it('r11-3: a restored counter cannot forge the barrier\'s own refusal', () => {
    // The barrier's message is the audit record of a REFUSED snapshot, so the
    // snapshot's own (unvalidated) counters must not be able to write a line
    // into it. A non-integer counter is described, not echoed.
    const ladder = threeRoundLadder();
    for (const value of ['3\nACCEPTED', { toString: 'x' }, null]) {
      const err = caught(() => reduceCourtConfirmationMachine(
        forge(ladder, { ladderRound: value }),
        { type: 'flag_clawback', idx: 1, reason: 'late', now: 7000 },
      ));
      expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message).not.toMatch(UNSAFE);
      expect(err.message).toContain('<not an integer>');
      expect(err.message).toMatch(/round counters disagree/);
    }
    // A numeric skew still names both numbers (the diagnostic is kept).
    const numeric = caught(() => reduceCourtConfirmationMachine(
      forge(ladder, { ladderRound: 4, ladder: { ...ladder.ladder!, round: 3 } }),
      { type: 'flag_clawback', idx: 1, reason: 'late', now: 7000 },
    ));
    expect(numeric.message).toMatch(/ladderRound is 4 but the open round is 3/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the exact bound (v0.15.0)
// ─────────────────────────────────────────────────────────────────────────────

describe('T4 (the exact bound) — the predicate, the clamp, and the parameter text', () => {
  const GRID = [0.30, 0.45, 0.5, 0.6, 0.75, 0.85, 0.9, 0.95, 1];

  it('r11-4: the exported cap IS the gate — cap is always allowed, cap + 1 never is', () => {
    // R52's claim, re-derived from the outside: no logarithm, no clamp-then-
    // compare. The gate is asked about the derived cap and one round deeper at
    // every parameter point a legal cap can reach.
    let checked = 0;
    for (const a_f of GRID) {
      for (const beta of [0.03, 0.09, 0.3, 3]) {
        const params = { a_f, rho: 0.03, beta };
        const cap = deriveMaxLadderRounds(params);
        expect(cap, JSON.stringify(params)).toBeGreaterThanOrEqual(0);
        expect(cap).toBeLessThanOrEqual(MAX_LADDER_ROUNDS);
        if (cap === 0) {
          // "0" means no legal ladder: the gate must not bless round 1.
          expect(ladderCapWithinBound({ ...params, maxLadderRounds: 1 }).ok).toBe(false);
          continue;
        }
        expect(ladderCapWithinBound({ ...params, maxLadderRounds: cap }).ok).toBe(true);
        if (cap + 1 <= MAX_LADDER_ROUNDS) {
          expect(ladderCapWithinBound({ ...params, maxLadderRounds: cap + 1 }).ok).toBe(false);
        }
        // …and the sign really is the sign (float cross-check, not the decision).
        expect(escalationOptionEv({ ...params, rounds: cap })).toBeLessThan(1e-12);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('r11-4: the clamp is applied AFTER the exact comparison, never before', () => {
    // The r40-4 class: clamp the DERIVATION (float `floor`) and then compare.
    // At `a_f = ½, β = 3ρ` the float derivation is exactly 2 (the break-even
    // round) and the old `floor` named it as the cap; the exact predicate
    // excludes it. Both halves are pinned.
    const boundary = { a_f: 0.5, rho: 1, beta: 3 };
    expect(Math.floor(Math.log(1 / 4) / Math.log(0.5))).toBe(2);
    expect(deriveMaxLadderRounds(boundary)).toBe(1);
    expect(deriveLadderFlipRound(boundary)).toBe(2);
    expect(ladderCapWithinBound({ ...boundary, maxLadderRounds: 2 }).ok).toBe(false);
    // The ceiling clamp only binds UPWARDS: a derivation deeper than the machine
    // ceiling is reported as the ceiling, and the gate is decided at the cap,
    // not at the clamp.
    const deep = { a_f: 0.9, rho: 0.03, beta: 0.03 };
    expect(deriveMaxLadderRounds(deep)).toBe(MAX_LADDER_ROUNDS);
    expect(deriveLadderFlipRound(deep)).toBe(MAX_LADDER_ROUNDS + 2);
    expect(ladderCapWithinBound({ ...deep, maxLadderRounds: MAX_LADDER_ROUNDS }).ok).toBe(true);
    // A perfect jury never flips: the cap is the ceiling, the flip is Infinity.
    const perfect = { a_f: 1, rho: 0.03, beta: 0.03 };
    expect(deriveMaxLadderRounds(perfect)).toBe(MAX_LADDER_ROUNDS);
    expect(deriveLadderFlipRound(perfect)).toBe(Number.POSITIVE_INFINITY);
  });

  it('r11-4: the parameter text is canonicalised through the DOUBLE, so spellings agree', () => {
    // `0.03`, `0.030` and `3e-2` are one double, so they are one rational and
    // one cap: no "two spellings, one digest" class here. (And the text form is
    // REFUSED — the input discipline the `a_f as a string` pin preserves; see
    // r11-5 for why that matters.)
    const spellings = [0.03, 0.030, 3e-2, 0.03e0, 3 / 100];
    for (const beta of spellings) {
      expect(Object.is(beta, 0.03), String(beta)).toBe(true);
      expect(deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta })).toBe(5);
      expect(deriveLadderFlipRound({ a_f: 0.9, rho: 0.03, beta })).toBe(7);
    }
    for (const bad of ['0.9', '0x0.8', '0.9d', ' 0.9', '']) {
      expect(() => deriveMaxLadderRounds({ a_f: bad as unknown as number, rho: 0.03, beta: 0.03 }), bad)
        .toThrow(/a_f must be a finite accuracy/);
    }
  });

  it('r11-5: two spellings of ONE economy diverge at the exact boundary (the residual)', () => {
    // MEASURED: β = 3ρ with ρ = 0.1. Written as a literal decimal the predicate
    // is exact (cap 1, break-even at 2 excluded). Written as ARITHMETIC the
    // parameter is the double `0.30000000000000004` — a different rational —
    // and the cap becomes 2, with the gate blessing the break-even round. This
    // is the class R52 closed, one layer down: the fix is exact about the
    // VALUE, and the value is whatever the caller computed.
    const literal = { a_f: 0.5, rho: 0.1, beta: 0.3 };
    const arithmetic = { a_f: 0.5, rho: 0.1, beta: 3 * 0.1 };
    expect(3 * 0.1).not.toBe(0.3);
    expect(deriveMaxLadderRounds(literal)).toBe(1);
    expect(deriveMaxLadderRounds(arithmetic)).toBe(2);
    expect(ladderCapWithinBound({ ...literal, maxLadderRounds: 2 }).ok).toBe(false);
    expect(ladderCapWithinBound({ ...arithmetic, maxLadderRounds: 2 }).ok).toBe(true);
    // The divergence is about the VALUE, not the syntax: the fuzz text is the
    // fuzz rational whatever form it arrives in.
    expect(deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: Number('0.30000000000000004') })).toBe(2);
    // Both spellings are individually honest: each satisfies the strict
    // predicate for ITS OWN rational. The residual is that only one of them is
    // the policy the host meant — a host obligation, registered in
    // `docs/REVIEW_ROUND_11.md` §4 with its trigger.
    expect(escalationOptionEv({ ...literal, rounds: 1 })).toBeLessThan(0);
    expect(escalationOptionEv({ ...arithmetic, rounds: 2 })).toBeGreaterThan(-1e-18);
  });

  it('r11-4: no parameter can overflow the scan or hang it', { timeout: testTimeoutFor(SCAN_BUDGET_MS) }, () => {
    // `exactRational` builds `10n ** k` from the shortest decimal text; the scan
    // is bounded at MAX_LADDER_ROUNDS (the flip round adds one). Extreme
    // exponents must not turn into an unbounded loop or a bogus cap.
    const extremes: readonly LadderParameters[] = [
      { a_f: Number.MIN_VALUE, rho: 1, beta: 1 },
      { a_f: 0.5, rho: Number.MIN_VALUE, beta: 1 },
      { a_f: 0.5, rho: 1, beta: Number.MAX_VALUE },
      { a_f: 0.9999999999999999, rho: 1, beta: 1e308 },
      { a_f: 1, rho: 5e-324, beta: 1.7976931348623157e308 },
    ];
    const started = Date.now();
    for (const params of extremes) {
      const cap = deriveMaxLadderRounds(params);
      expect(Number.isSafeInteger(cap), JSON.stringify(params)).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(0);
      expect(cap).toBeLessThanOrEqual(MAX_LADDER_ROUNDS);
      const flip = deriveLadderFlipRound(params);
      expect(Number.isNaN(flip), JSON.stringify(params)).toBe(false);
    }
    // A hang detector, not a performance pin (docs/TEST_DETERMINISM.md rule 4):
    // the budget is env-overridable and generous, and its liveness is proven by
    // determinismGuard.test.ts. It stays an IN-BODY assertion on purpose —
    // the scan is synchronous, and vitest's timeout cannot interrupt a
    // synchronous loop, so an in-body check is the only ceiling that can fire.
    const scans = 60;
    for (let i = 0; i < scans; i += 1) {
      deriveMaxLadderRounds({ a_f: 0.5 + i / 1000, rho: 5e-324, beta: 1e308 });
    }
    expect(Date.now() - started, `ladder scan exceeded its ${SCAN_BUDGET_MS} ms watchdog`)
      .toBeLessThan(SCAN_BUDGET_MS);
  });

  it('r11-4: flipRound is telemetry — it never understates the first unsafe round', () => {
    // The decision never reads it (that is the R52 split), so the only property
    // it must keep is that a monitoring alert cannot be lulled: the flip round
    // is never BELOW the first round the exact predicate calls unsafe.
    for (const a_f of GRID) {
      const params = { a_f, rho: 0.03, beta: 0.03 };
      const cap = deriveMaxLadderRounds(params);
      const flip = deriveLadderFlipRound(params);
      if (cap < MAX_LADDER_ROUNDS) {
        expect(flip, JSON.stringify(params)).toBe(cap + 1);
      } else {
        expect(flip, JSON.stringify(params)).toBeGreaterThanOrEqual(MAX_LADDER_ROUNDS + 1);
      }
    }
    // A jurisdiction with a huge bond can push the crossing past the ceiling:
    // the reported number is the logarithmic one, floored at MAX + 2.
    const huge = deriveLadderFlipRound({ a_f: 0.5, rho: 1, beta: 1e6 });
    expect(huge).toBeGreaterThanOrEqual(MAX_LADDER_ROUNDS + 2);
    expect(deriveMaxLadderRounds({ a_f: 0.5, rho: 1, beta: 1e6 })).toBe(MAX_LADDER_ROUNDS);
  });
});
