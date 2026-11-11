// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Review round 10 — attacking the round-9 fixes (v0.14.2).
 *
 * Round 9 closed four fields: the `caseId` fold (r9-1), the unbound
 * `bondTxid` (r9-2), the CONCESSION→ESCALATION conversion (r9-3) and the
 * one-counter history rule (r9-4) — and replaced the worthless 2 000-id
 * "injectivity pin" with a byte differential (r9-5). This file attacks those
 * five closures, in the round's method: the guard is called with hostile input,
 * the reducer is attacked as an API, and every documentary claim is re-derived
 * from the code.
 *
 * Findings (`docs/REVIEW_ROUND_10.md` has the repro + disposition):
 *
 *   T1  r10-1 the exact-id guard HOLDS for every whitespace and for the
 *       zero-width/bidi class, but the REFUSAL PATH echoed the offending id
 *       verbatim — a newline inside an id (only the ENDS are whitespace-checked)
 *       forged a log line in the very refusal that documented the guard (FIXED);
 *   T2  r9-2's comparison is the txid of the record the witness selects, and one
 *       witness cannot be re-bound to a second challenge — BLOCKED; the txid is
 *       not a bond IDENTITY (one transaction may fund two bonds), which the fix
 *       must not be quoted as saying (pin + doc correction);
 *   T3  r10-3 r9-3 was a FIELD check, not a signature-domain binding: the same
 *       signed concession re-presented with `concession: false` was accepted and
 *       hashed as an escalation nobody signed, and the mirror direction had no
 *       guard at all (FIXED with a signed-event binder);
 *   T4  r10-4 r9-4 checked two of the four readers; `finalize` still accepted a
 *       skewed ladder and minted an EARLIER round's verdict over the last paid
 *       round's decision (FIXED on every value/seat-locking entry);
 *   T5  r9-5's differential pin is strong against lossy and folding encoders but
 *       blind to a digest-domain-only change — measured by mutating a copy of the
 *       canonicaliser (PARTIAL → the whole preimage is now pinned in one place).
 */

import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  COURT_ESCALATION_REQUEST_DOMAIN,
  MAX_ESCALATION_CASE_ID_BYTES,
  buildCourtEscalationRequest,
  courtEscalationRequestPreimage,
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

/** A challenged case parked at `challenge_window` (nothing challenged yet). */
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

/** A challenged case parked in `round_resolved` after round 1 resolves `NO`. */
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

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

// Every code point `String.prototype.trim` removes (WhiteSpace ∪ LineTerminator).
const TRIM_WHITESPACE: ReadonlyArray<readonly [string, string]> = [
  ['U+0009 TAB', '\u0009'], ['U+000A LF', '\u000a'], ['U+000B VT', '\u000b'],
  ['U+000C FF', '\u000c'], ['U+000D CR', '\u000d'], ['U+0020 SPACE', '\u0020'],
  ['U+00A0 NBSP', '\u00a0'], ['U+1680 OGHAM', '\u1680'],
  ['U+2000 EN QUAD', '\u2000'], ['U+2001 EM QUAD', '\u2001'], ['U+2002 EN SPACE', '\u2002'],
  ['U+2003 EM SPACE', '\u2003'], ['U+2004 3-PER-EM', '\u2004'], ['U+2005 4-PER-EM', '\u2005'],
  ['U+2006 6-PER-EM', '\u2006'], ['U+2007 FIGURE', '\u2007'], ['U+2008 PUNCTUATION', '\u2008'],
  ['U+2009 THIN', '\u2009'], ['U+200A HAIR', '\u200a'],
  ['U+2028 LINE SEP', '\u2028'], ['U+2029 PARA SEP', '\u2029'],
  ['U+202F NNBSP', '\u202f'], ['U+205F MMSP', '\u205f'], ['U+3000 IDEOGRAPHIC', '\u3000'],
  ['U+FEFF BOM/ZWNBSP', '\ufeff'],
];

// Zero-width / bidi / format characters that `trim` does NOT remove — they are
// legal inside an id, which is exactly why the refusal path must escape them.
const FORMAT_CHARS: ReadonlyArray<readonly [string, string]> = [
  ['U+200B ZWSP', '\u200b'], ['U+200C ZWNJ', '\u200c'], ['U+200D ZWJ', '\u200d'],
  ['U+200E LRM', '\u200e'], ['U+200F RLM', '\u200f'], ['U+061C ALM', '\u061c'],
  ['U+202A LRE', '\u202a'], ['U+202B RLE', '\u202b'], ['U+202C PDF', '\u202c'],
  ['U+202D LRO', '\u202d'], ['U+202E RLO', '\u202e'], ['U+2066 LRI', '\u2066'],
  ['U+2067 RLI', '\u2067'], ['U+2068 FSI', '\u2068'], ['U+2069 PDI', '\u2069'],
  ['U+00AD SOFT HYPHEN', '\u00ad'], ['U+180E MVS', '\u180e'], ['U+0085 NEL', '\u0085'],
];

/** Characters a log line must never contain verbatim. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

// ─────────────────────────────────────────────────────────────────────────────
// T1 — the exact id (r9-1 attacked): the guard, and the REFUSAL PATH
// ─────────────────────────────────────────────────────────────────────────────

describe('T1 (r9-1 attacked) — every whitespace code point, both ends', () => {
  it('the whole ES-trim class is refused, at the front and at the back', () => {
    // r9 pinned seven of these; `trim` removes twenty-five. A guard that
    // enumerates "space, tab, newline, …" is one Unicode release away from
    // folding again, so the property is checked against the CLASS, not a list.
    expect(TRIM_WHITESPACE).toHaveLength(25);
    for (const [label, ch] of TRIM_WHITESPACE) {
      expect(ch.trim(), `${label} must be trimmed by String#trim`).toBe('');
      const trailing = caught(() => buildCourtEscalationRequest({ ...request(), caseId: CASE_ID + ch }));
      const leading = caught(() => buildCourtEscalationRequest({ ...request(), caseId: ch + CASE_ID }));
      expect(trailing, label).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(leading, label).toBeInstanceOf(CourtConfirmationTransitionError);
      // Whitespace-only keeps the more specific (empty-id) refusal; a LEADING
      // U+FEFF is refused one step earlier, by the canonical-UTF-8 round-trip
      // (`TextDecoder` strips a leading BOM), which r9 documented.
      expect(trailing.message, label).toMatch(/whitespace|non-empty string/);
      expect(leading.message, label)
        .toMatch(/whitespace|non-empty string|canonical UTF-8/);
    }
  });

  it('the refusal is TOTAL: no id differing only by a refused character can verify', () => {
    // The harm r9-1 closed is "two spellings, one digest". The proof that it
    // cannot come back by another character is that one member of every such
    // pair is REFUSED: there is no second accepted spelling to share a digest
    // with. Both halves are asserted — the exact id still maps end-to-end.
    const state = resolvedRoundOne();
    for (const [label, ch] of TRIM_WHITESPACE) {
      expect(() => buildCourtEscalationRequest({ ...request(), caseId: CASE_ID + ch }), label).toThrow();
      expect(() => buildCourtEscalationRequest({ ...request(), caseId: ch + CASE_ID }), label).toThrow();
      // …and the plain id still produces a reducer event (the over-strictness
      // control: a guard that refused the class by refusing everything is not a
      // guard).
      expect(escalationRequestToMachineEvent(state, request(), 3300, BINDING).bondProofHash, label)
        .toBe(MEMBERSHIP_BOND);
    }
    // Identity, not a quotient: `build` returns exactly what it was given for
    // every accepted id, so the accepted domain is a SUBSET of the wire strings
    // (injective by construction) rather than their image under a fold.
    for (const id of [CASE_ID, `${CASE_ID}x`, 'court:caf\u00e9:1', 'a\ud83d\ude00b', 'x'.repeat(256)]) {
      expect(buildCourtEscalationRequest({ ...request(), caseId: id }).caseId, id).toBe(id);
    }
  });

  it('zero-width and bidi characters are NOT folded — two ids, two preimages (intended)', () => {
    // `trim` does not remove these, so they are legal INSIDE an id and the two
    // spellings are two distinct ids with two distinct digests. That is the
    // intended direction (folding them would manufacture the collision r9-1
    // closed); the residual is the display/audit confusable r9 documented for
    // NFC/NFD, and the refusal path now escapes them (r10-1, below).
    for (const [label, ch] of FORMAT_CHARS) {
      const marked = buildCourtEscalationRequest({ ...request(), caseId: `${CASE_ID}${ch}` });
      expect(marked.caseId, label).toBe(`${CASE_ID}${ch}`);
      expect(courtEscalationRequestPreimage(marked), label)
        .not.toBe(courtEscalationRequestPreimage(request()));
      expect(hashCourtEscalationRequest(marked), label)
        .not.toBe(hashCourtEscalationRequest(request()));
      // They render identically — that is the residual, stated not hidden.
      expect(`${CASE_ID}${ch}`.replace(/[\p{Cf}\p{Cc}]/gu, ''), label).toBe(CASE_ID);
    }
  });

  it('r10-1: a refused id can no longer forge a log line', () => {
    // MEASURED ON v0.14.2: the refusal message interpolated the id verbatim, and
    // an id's INTERIOR is not whitespace-checked, so an attacker's id put a
    // whole forged line into the operator's log:
    //   escalation request names case "court:A
    //   ESCALATION ACCEPTED for case court:target:1" but the host bound it to …
    const state = resolvedRoundOne();
    const forgedId = 'court:A\nESCALATION ACCEPTED for case court:target:1';
    const err = caught(() => escalationRequestToMachineEvent(
      state, request({ caseId: forgedId }), 3300, BINDING,
    ));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).not.toMatch(UNSAFE);
    expect(err.message).toContain('\\u{a}');
    // The reason survives — the fix must not turn a diagnostic into a shrug.
    expect(err.message).toMatch(/must not cross cases/);
    // A bidi override does the same to a RENDERED line without any newline.
    const bidiErr = caught(() => escalationRequestToMachineEvent(
      state, request({ caseId: `court:A\u202eICAF` }), 3300, BINDING,
    ));
    expect(bidiErr.message).not.toMatch(UNSAFE);
    expect(bidiErr.message).toContain('\\u{202e}');
    // The HOST's own id is echoed too (it is the one value in the message the
    // caller did not supply), so it is escaped and bounded on the same terms.
    const hostErr = caught(() => escalationRequestToMachineEvent(state, request(), 3300, {
      caseId: 'court:other\u202e:1', authenticatedPubkey: CHALLENGER_PUBKEY,
    }));
    expect(hostErr.message).not.toMatch(UNSAFE);
    expect(hostErr.message).toContain('\\u{202e}');
    // A 256-byte id must not double into a 512-byte log entry.
    const longId = 'a'.repeat(MAX_ESCALATION_CASE_ID_BYTES);
    const longErr = caught(() => escalationRequestToMachineEvent(
      state, request({ caseId: longId }), 3300, BINDING,
    ));
    expect(longErr.message.length).toBeLessThan(400);
    expect(longErr.message).toContain('…');
  });

  it('r10-1: the other three echo sites are escaped too (round, unknown field, repeated field)', () => {
    // Each of these interpolates a WIRE value into a refusal, and each is
    // reachable straight from the untrusted body text.
    const roundErr = caught(() => buildCourtEscalationRequest({
      ...request(), round: '1\nFAKE ACCEPTED' as unknown as number,
    }));
    expect(roundErr).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(roundErr.message).not.toMatch(UNSAFE);
    expect(roundErr.message).toContain('\\u{a}');
    expect(roundErr.message).toMatch(/must be an integer in 1\.\.5/);

    const unknown = `{"caseId":"${CASE_ID}","a\\nb":1}`;
    const unknownErr = caught(() => parseCourtEscalationRequest(
      JSON.stringify({ ...JSON.parse(serializeCourtEscalationRequest(request())), 'a\nb': 1 }),
    ));
    expect(unknownErr.message).not.toMatch(UNSAFE);
    expect(unknownErr.message).toContain('\\u{a}');
    // A JSON body carrying the raw escape is the same refusal.
    expect(() => parseCourtEscalationRequest(unknown)).toThrow(CourtConfirmationTransitionError);

    const repeated = serializeCourtEscalationRequest(request()).replace(
      '"caseId":', '"a\\nb":1,"a\\nb":2,"caseId":',
    );
    const repeatErr = caught(() => parseCourtEscalationRequest(repeated));
    expect(repeatErr).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(repeatErr.message).toMatch(/repeats the field/);
    expect(repeatErr.message).not.toMatch(UNSAFE);
    expect(repeatErr.message).toContain('\\u{a}');
  });

  it('the refusal SHAPE: typed, self-describing, and it discloses nothing secret', () => {
    // The brief's oracle question. The reasons DO differ (whitespace vs length vs
    // NUL vs canonicality) — deliberately: the caller supplied that value, so
    // naming the rule is a diagnostic, not an oracle. What must NOT vary is the
    // error CLASS (hosts branch on it) and the presence of the value in a
    // re-interpretable form (asserted above).
    const reasons = [
      caught(() => buildCourtEscalationRequest({ ...request(), caseId: `${CASE_ID} ` })),
      caught(() => buildCourtEscalationRequest({ ...request(), caseId: 'a'.repeat(257) })),
      caught(() => buildCourtEscalationRequest({ ...request(), caseId: 'a\u0000b' })),
      caught(() => buildCourtEscalationRequest({ ...request(), caseId: 'a\ud800' })),
      caught(() => buildCourtEscalationRequest({ ...request(), caseId: '' })),
    ];
    for (const err of reasons) {
      expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
      expect(err.message).toMatch(/leading or trailing whitespace|exceeds|U\+0000|canonical UTF-8|non-empty/);
      // No length oracle beyond the documented bound, no digest, no state.
      expect(err.message).not.toMatch(/[0-9a-f]{32}/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the bondTxid comparison (r9-2 attacked)
// ─────────────────────────────────────────────────────────────────────────────

describe('T2 (r9-2 attacked) — the hash, the txid, and the witness', () => {
  it('the witness selects the record; the txid must be THAT record\'s txid', () => {
    const state = resolvedRoundOne();
    // The comparison is exact and one-directional: the case is the source.
    expect(state.challenges[0].bondTxid).toBe(BOND_TXID);
    expect(state.challenges[0].bondProofHash).toBe(MEMBERSHIP_BOND);
    expect(() => escalationRequestToMachineEvent(
      state, request({ bondTxid: OTHER_PUBKEY }), 3300, BINDING,
    )).toThrow(/commit to a bond this case never bound/);
    // A restored record with no txid (a legacy shape) fails CLOSED: `undefined`
    // can never equal the wire's hex32.
    const noTxid = forge(state, {
      challenges: state.challenges.map(({ bondTxid: _drop, ...rest }) => rest),
    });
    expect(() => escalationRequestToMachineEvent(noTxid, request(), 3300, BINDING))
      .toThrow(CourtConfirmationTransitionError);
    // The event the mapper mints carries the witness, NOT the txid: the reducer's
    // ledger never sees a txid, so the request hash is the only place it lives —
    // which is why binding it there (r9-2) mattered at all.
    const event = escalationRequestToMachineEvent(state, request(), 3300, BINDING);
    expect(Object.keys(event)).not.toContain('bondTxid');
    expect(event.bondProofHash).toBe(MEMBERSHIP_BOND);
  });

  it('a witness cannot be re-bound to a second challenge (one hash, one owner)', () => {
    // At the CHALLENGE level, not only the round level: the ledger refuses the
    // second registration, so the "two records, one witness" shape the mapper
    // calls ambiguous is unreachable through the reducer.
    const s = challengeWindow();
    const first = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge', idx: 2, bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND, eventId: hid('c2'), now: 1200,
    });
    expect(first.challenges).toHaveLength(1);
    const dup = caught(() => reduceCourtConfirmationMachine(first, {
      type: 'accept_challenge', idx: 3, bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND, eventId: hid('c3'), now: 1300,
    }));
    expect(dup).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(dup.message).toMatch(/one bond witness buys one challenger's standing/);
    // …and one participant cannot hold two challenges either.
    expect(() => reduceCourtConfirmationMachine(first, {
      type: 'accept_challenge', idx: 2, bondTxid: hexId('b'),
      bondProofHash: hid('f1'), eventId: hid('c4'), now: 1300,
    })).toThrow(/conflicting challenge/);
    // The restored two-owner shape is refused by the mapper (ambiguous), so the
    // one witness has exactly one escalation path or none.
    const ambiguous = forge(resolvedRoundOne(), {
      challenges: [
        { ...first.challenges[0] },
        { ...first.challenges[0], idx: 3, eventId: hid('c3') },
      ],
    });
    expect(() => escalationRequestToMachineEvent(ambiguous, request(), 3300, BINDING))
      .toThrow(/witness is ambiguous/);
  });

  it('the txid is NOT the bond identity: one transaction may fund two bonds', () => {
    // The r9-2 fix compares the txid of the record the WITNESS selects. It is
    // not (and cannot be) a uniqueness rule on txids: a bond transaction may fund
    // two challengers, so refusing a repeated txid would refuse a legitimate
    // second challenger. The witness — not the txid — is what identifies a bond,
    // and this pin keeps the r9-2 claim from being quoted as the stronger one.
    const s = challengeWindow();
    let t = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge', idx: 2, bondTxid: BOND_TXID,
      bondProofHash: MEMBERSHIP_BOND, eventId: hid('c2'), now: 1200,
    });
    t = reduceCourtConfirmationMachine(t, {
      type: 'accept_challenge', idx: 3, bondTxid: BOND_TXID,
      bondProofHash: hid('f1'), eventId: hid('c3'), now: 1300,
    });
    expect(t.challenges.map((c) => c.bondTxid)).toEqual([BOND_TXID, BOND_TXID]);
    // Both are distinct bonds to the machine, and the second one's escalation is
    // bound to its OWN witness (the mapper selects by witness, then checks the
    // txid against that record).
    const two = forge(resolvedRoundOne(), {
      challenges: [
        { idx: 2, bondTxid: BOND_TXID, bondProofHash: MEMBERSHIP_BOND, eventId: hid('c2') },
        { idx: 3, bondTxid: BOND_TXID, bondProofHash: hid('f1'), eventId: hid('c3') },
      ],
    });
    expect(escalationRequestToMachineEvent(two, request(), 3300, BINDING).challengerIdx).toBe(2);
    expect(escalationRequestToMachineEvent(
      two, request({ bondProofHash: hid('f1') }), 3300,
      { caseId: CASE_ID, authenticatedPubkey: CHALLENGER_PUBKEY },
    ).challengerIdx).toBe(3);
  });

  it('a derivable witness preemptor locks the PAYER out of the challenge, not just the attribution', () => {
    // r9-7 registered the attribution harm. The sharper consequence, pinned here:
    // uniqueness is first-come-first-served, so a juror who copies the payer's
    // publicly derivable witness does not merely take the credit — the payer's
    // OWN challenge is then refused, and the payer can never escalate either
    // (`escalate` requires an accepted challenge of the caller's index). One
    // paid bond, one stolen challenger role, and the payer's dispute is heard
    // only at the copier's discretion.
    const payerTxid = hexId('c');
    const derivable = bytesToHex(sha256(utf8(payerTxid)));
    let s = challengeWindow();
    s = reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge', idx: 3, bondTxid: payerTxid,
      bondProofHash: derivable, eventId: hid('c3'), now: 1200,
    });
    const err = caught(() => reduceCourtConfirmationMachine(s, {
      type: 'accept_challenge', idx: 2, bondTxid: payerTxid,
      bondProofHash: derivable, eventId: hid('c2'), now: 1300,
    }));
    expect(err.message).toMatch(/already bound to participant 3/);
    // The copier's escalation maps to the copier — the machine cannot tell them
    // apart, so this is the host bond verifier's obligation (r9-7, unchanged).
    s = reduceCourtConfirmationMachine(s, { type: 'close_challenge_window', now: 2000 });
    s = voteRound(s, 1, 'NO', 2050);
    const event = escalationRequestToMachineEvent(s, request({
      bondTxid: payerTxid, bondProofHash: derivable,
    }), 3300, BINDING);
    expect(event.challengerIdx).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — concession vs escalation (r9-3 attacked): the FIELD vs the SIGNATURE
// ─────────────────────────────────────────────────────────────────────────────

/** A real, signed request event for `request`, with `content` = the canonical wire form. */
function signedRequestEvent(
  req: CourtEscalationRequest,
  sk: Uint8Array,
  over: { kind?: number; created_at?: number; content?: string; tags?: string[][] } = {},
): CourtEscalationRequestEvent {
  return finalizeEvent({
    kind: over.kind ?? 39008,
    created_at: over.created_at ?? req.signedAtSec,
    tags: over.tags ?? [['d', req.caseId]],
    content: over.content ?? courtEscalationRequestSignedContent(req),
  }, sk) as unknown as CourtEscalationRequestEvent;
}

describe('T3 (r9-3 attacked) — is the claim bound at the SIGNATURE domain?', () => {
  it('the preimage is kind-bound at the FIELD: the flag is the last slot and flips the digest', () => {
    const escalate = request({ concession: false });
    const concede = request({ concession: true });
    expect(courtEscalationRequestPreimage(escalate).endsWith('\u00000')).toBe(true);
    expect(courtEscalationRequestPreimage(concede).endsWith('\u00001')).toBe(true);
    expect(hashCourtEscalationRequest(escalate)).not.toBe(hashCourtEscalationRequest(concede));
    // The mapper refuses the honest concession body (the r9-3 guard).
    expect(() => escalationRequestToMachineEvent(resolvedRoundOne(), concede, 3300, BINDING))
      .toThrow(/CONCESSION/);
  });

  it('r10-3: that guard is a FIELD check — the SAME signed event re-labelled escalates', () => {
    // MEASURED ON v0.14.2. The request's `eventId` is asserted to be hex32 and
    // nothing more: no function in this package ties it to the bytes the
    // challenger signed. So the flag is a field the CALLER sets, and clearing it
    // on a signed concession produced a valid escalate event whose requestHash
    // is the hash of a request nobody signed.
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const concession = request({ challengerPubkey: pubkey, concession: true });
    const event = signedRequestEvent(concession, sk);
    const signed = request({ challengerPubkey: pubkey, concession: true, eventId: event.id });
    const binding = { caseId: CASE_ID, authenticatedPubkey: pubkey };
    const state = resolvedRoundOne();
    expect(() => escalationRequestToMachineEvent(state, signed, 3300, binding))
      .toThrow(/CONCESSION/);
    const flipped = request({ challengerPubkey: pubkey, concession: false, eventId: event.id });
    const minted = escalationRequestToMachineEvent(state, flipped, 3300, binding);
    // The digest the log records is NOT the digest of what was signed.
    expect(minted.requestHash).not.toBe(hashCourtEscalationRequest(signed));
    expect(minted.requestHash).toBe(hashCourtEscalationRequest(flipped));
    // …and the reducer accepts the minted event: the case climbs a rung on a
    // signature that said "drop the appeal".
    expect(reduceCourtConfirmationMachine(state, minted).phase).toBe('ladder_pending');
  });

  it('r10-3: the signed-event binder refuses the flip in BOTH directions', () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const bindingFor = (req: CourtEscalationRequest): CourtEscalationRequestEvent =>
      signedRequestEvent(req, sk);
    // Direction 1: signed CONCESSION, body claims escalation.
    const concession = request({ challengerPubkey: pubkey, concession: true });
    const concessionEvent = signedRequestEvent(concession, sk);
    const signedConcession = request({
      challengerPubkey: pubkey, concession: true, eventId: concessionEvent.id,
    });
    const flippedToEscalate = request({
      challengerPubkey: pubkey, concession: false, eventId: concessionEvent.id,
    });
    const err1 = caught(() => escalationRequestBindingFromSignedEvent(
      flippedToEscalate, concessionEvent, 39008,
    ));
    expect(err1).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err1.message).toMatch(/not the canonical serialization/);
    // Direction 2: signed ESCALATION, body claims concession — the mirror harm,
    // which had NO guard at all (the package has no concession transition, so
    // the host reads the flag).
    const escalate = request({ challengerPubkey: pubkey, concession: false });
    const escalateEvent = bindingFor(escalate);
    const signedEscalate = request({
      challengerPubkey: pubkey, concession: false, eventId: escalateEvent.id,
    });
    const flippedToConcede = request({
      challengerPubkey: pubkey, concession: true, eventId: escalateEvent.id,
    });
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      flippedToConcede, escalateEvent, 39008,
    )).message).toMatch(/not the canonical serialization/);
    // The honest pair binds in both cases — the binder is not "refuse everything".
    expect(escalationRequestBindingFromSignedEvent(signedConcession, concessionEvent, 39008))
      .toEqual({ caseId: CASE_ID, authenticatedPubkey: pubkey });
    expect(escalationRequestBindingFromSignedEvent(signedEscalate, escalateEvent, 39008))
      .toEqual({ caseId: CASE_ID, authenticatedPubkey: pubkey });
  });

  it('r10-3: the same nonce/event id cannot carry two kinds — the kind is inside the id', () => {
    // "Same nonce, both kinds" is the replay the brief asks about. There is no
    // nonce in this wire; the closest thing is the event id, so the question is
    // whether one id can authorise two claims. It cannot: `kind` is one of the
    // seven fields the Nostr id commits to, and the binder checks the host's
    // expected kind before anything else.
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const req = request({ challengerPubkey: pubkey });
    const event = signedRequestEvent(req, sk);
    const signed = request({ challengerPubkey: pubkey, eventId: event.id });
    const otherKind = signedRequestEvent(req, sk, { kind: 39009 });
    expect(caught(() => escalationRequestBindingFromSignedEvent(signed, event, 39009))
      .message).toMatch(/kind/);
    // A different kind is a different id — so the id cannot be reused across
    // kinds either (getEventHash covers the kind).
    expect(otherKind.id).not.toBe(event.id);
    // And the wire itself has no kind field: a caller cannot set one.
    const wire = JSON.parse(serializeCourtEscalationRequest(signed)) as Record<string, unknown>;
    expect(() => parseCourtEscalationRequest(JSON.stringify({ ...wire, kind: 'escalate' })))
      .toThrow(/unknown field kind/);
  });

  it('r10-3: the binder refuses every other substitution (author, time, id, signature)', () => {
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const req = request({ challengerPubkey: pubkey });
    const event = signedRequestEvent(req, sk);
    const signed = request({ challengerPubkey: pubkey, eventId: event.id });
    // Wrong author: the event was signed by someone else.
    const otherSk = generateSecretKey();
    const foreign = signedRequestEvent(req, otherSk);
    // NB: a request claiming `pubkey` cannot be presented with an event authored
    // by `getPublicKey(otherSk)` — content mismatch AND author mismatch.
    expect(() => escalationRequestBindingFromSignedEvent(
      request({ challengerPubkey: pubkey, eventId: foreign.id }), foreign, 39008,
    )).toThrow(CourtConfirmationTransitionError);
    // Wrong time.
    const later = request({ challengerPubkey: pubkey, eventId: event.id, signedAtSec: 1_790_000_001 });
    expect(caught(() => escalationRequestBindingFromSignedEvent(later, event, 39008))
      .message).toMatch(/created_at/);
    // Wrong event id.
    expect(caught(() => escalationRequestBindingFromSignedEvent(
      request({ challengerPubkey: pubkey, eventId: hexId('9') }), event, 39008,
    )).message).toMatch(/event id/);
    // Tampered signature: same id and content, different sig.
    const tampered = { ...event, sig: `${'0'.repeat(128)}` };
    expect(caught(() => escalationRequestBindingFromSignedEvent(signed, tampered, 39008))
      .message).toMatch(/signature does not verify/);
    // Tampered content: the id no longer describes the content.
    const tamperedContent = { ...event, content: `${event.content} ` };
    expect(() => escalationRequestBindingFromSignedEvent(signed, tamperedContent, 39008))
      .toThrow(CourtConfirmationTransitionError);
  });

  it('r10-3 closes r9-6: the binding is DERIVED from the signature, not echoed from the body', () => {
    // The r9-6 boundary was "a host can fill the binding from the wire". With the
    // binder the host passes the signed event it received and the pubkey falls
    // out of the signature — so the honest path no longer needs a value the body
    // supplied, and the echoed-binding forgery cannot be spelled.
    const sk = generateSecretKey();
    const pubkey = getPublicKey(sk);
    const req = request({ challengerPubkey: pubkey });
    const event = signedRequestEvent(req, sk);
    const signed = request({ challengerPubkey: pubkey, eventId: event.id });
    const state = resolvedRoundOne();
    const derived = escalationRequestBindingFromSignedEvent(signed, event, 39008);
    const minted = escalationRequestToMachineEvent(state, signed, 3300, derived);
    expect(minted.challengerPubkey).toBe(pubkey);
    expect(minted.challengerIdx).toBe(2);
    // A request whose author claim is not the signer is refused by the BINDER,
    // before the mapper's trust anchor is ever consulted.
    const claim = request({ challengerPubkey: OTHER_PUBKEY, eventId: event.id });
    expect(caught(() => escalationRequestBindingFromSignedEvent(claim, event, 39008))
      .message).toMatch(/not the canonical serialization|not the author/);
    // The reducer still records the challenger from the case, not the wire.
    const next = reduceCourtConfirmationMachine(state, minted);
    expect(next.escalationLog.at(-1)).toMatchObject({ challengerIdx: 2, challengerPubkey: pubkey });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the ladder's two round counters (r9-4 attacked)
// ─────────────────────────────────────────────────────────────────────────────

describe('T4 (r9-4 attacked) — the counters on EVERY reader', () => {
  /** A three-round ladder walked honestly to `fee_settlement`, round 3 = NO. */
  function threeRounds(): {
    afterTwo: CourtConfirmationMachineState;
    afterThree: CourtConfirmationMachineState;
  } {
    let s = resolvedRoundOne();
    s = reduceCourtConfirmationMachine(s, escalationRequestToMachineEvent(s, request(), 3300, BINDING));
    const afterTwo = voteRound(s, 2, 'YES', 3350);
    const s3 = reduceCourtConfirmationMachine(
      afterTwo,
      escalationRequestToMachineEvent(
        afterTwo, request({ round: 2, roundBondProofHash: hid('a3') }), 4450, BINDING,
      ),
    );
    return { afterTwo, afterThree: voteRound(s3, 3, 'NO', 4500) };
  }

  it('the machine never produces a skew — the counters agree at every step', () => {
    const { afterTwo, afterThree } = threeRounds();
    expect([afterTwo.ladderRound, afterTwo.ladder!.round]).toEqual([2, 2]);
    expect([afterThree.ladderRound, afterThree.ladder!.round]).toEqual([3, 3]);
    expect(afterThree.phase).toBe('fee_settlement');
    expect(afterThree.outcomeHistory.map((r) => `${r.round}:${r.outcome}`))
      .toEqual(['1:NO', '2:YES', '3:NO']);
    expect(afterThree.escalationLog.map((r) => r.round)).toEqual([2, 3]);
    // …and the half-step (`ladder_pending`, between escalate and
    // open_ladder_round) keeps them equal too, which is what makes the invariant
    // safe as a pre-dispatch barrier.
    const pending = reduceCourtConfirmationMachine(
      afterTwo, escalationRequestToMachineEvent(
        afterTwo, request({ round: 2, roundBondProofHash: hid('a4') }), 4450, BINDING,
      ),
    );
    expect(pending.phase).toBe('ladder_pending');
    expect([pending.ladderRound, pending.ladder!.round]).toEqual([2, 2]);
  });

  it('r10-4: finalize accepted a skewed ladder and minted an EARLIER round\'s verdict', () => {
    // MEASURED ON v0.14.2: every barrier `finalize` runs passes a snapshot with
    // `ladderRound = 3` (two escalations on the append-only log — two round
    // bonds consumed, two panels seated) and `ladder.round = 2`, and the verdict
    // it mints is ROUND 2's. The last paid panel's decision is discarded and the
    // case's own audit trail contradicts the finality it just produced.
    const { afterTwo, afterThree } = threeRounds();
    const snapshot = JSON.stringify(afterThree);
    const skewed = forge(afterThree, {
      ladderRound: 3,
      ladder: { ...afterTwo.ladder, round: 2 },
      outcomeHistory: afterThree.outcomeHistory.slice(0, 2),
      verdict: afterTwo.verdict,
    });
    const err = caught(() => reduceCourtConfirmationMachine(skewed, { type: 'finalize', now: 9999 }));
    expect(err).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(err.message).toMatch(/round counters disagree/);
    // Purity: the forged snapshot is untouched (no partial work).
    expect(JSON.stringify(afterThree)).toBe(snapshot);
    // The consistent forgery (both counters 2) is refused by the r8-6 history
    // rule instead — together the two guards close the shape from both sides.
    const consistent = forge(afterThree, {
      ladderRound: 2,
      ladder: { ...afterTwo.ladder, round: 2 },
      outcomeHistory: afterThree.outcomeHistory.slice(0, 2),
    });
    const consistentErr = caught(() => reduceCourtConfirmationMachine(
      consistent, { type: 'finalize', now: 9999 },
    ));
    expect(consistentErr).toBeInstanceOf(CourtConfirmationTransitionError);
    expect(consistentErr.message)
      .toMatch(/round counters disagree|log is incomplete|holds .* record\(s\)|vote ledger/);
    // Over-strictness control: the honest snapshot still finalizes, and it
    // finalizes ROUND 3's outcome.
    const final = reduceCourtConfirmationMachine(forge(afterThree, {}), { type: 'finalize', now: 9999 });
    expect(final.phase).toBe('final');
    expect(final.verdict?.outcome).toBe('NO');
  });

  it('r10-4: the skew cannot be laundered through concede → finalize either', () => {
    const { afterTwo } = threeRounds();
    const skewed = forge(afterTwo, { ladderRound: 3 });
    // `concede` locks nothing in by itself (r41-1), so it still accepts the
    // snapshot — and `finalize` is where the value moves.
    const conceded = reduceCourtConfirmationMachine(skewed, { type: 'concede', now: 5000 });
    expect(conceded.phase).toBe('fee_settlement');
    expect(() => reduceCourtConfirmationMachine(conceded, { type: 'finalize', now: 5100 }))
      .toThrow(/round counters disagree/);
  });

  it('r10-4: escalate and open_ladder_round refuse a skew before spending a seat', () => {
    // Both entries consume a rung: `escalate` writes the log record (and the
    // round bond it names can never be presented again), `open_ladder_round`
    // writes BOTH counters, healing a skew into a jump the outcome history can
    // never satisfy. Neither may run on a state the machine could not produce.
    const afterTwo = voteRound(
      reduceCourtConfirmationMachine(
        resolvedRoundOne(),
        escalationRequestToMachineEvent(resolvedRoundOne(), request(), 3300, BINDING),
      ), 2, 'YES', 3350,
    );
    const skewedResolved = forge(afterTwo, { ladderRound: 3 });
    expect(caught(() => reduceCourtConfirmationMachine(skewedResolved, {
      type: 'escalate', authority: 'host', challengerIdx: null, challengerPubkey: null,
      requestHash: null, bondProofHash: null, roundIndex: 4, now: 5000,
    })).message).toMatch(/round counters disagree/);
    const skewedPending = forge(afterTwo, {
      ladderRound: 3,
      phase: 'ladder_pending',
      escalationLog: [...afterTwo.escalationLog,
        { round: 3, authority: 'host', challengerIdx: null, challengerPubkey: null,
          requestHash: null, bondProofHash: null, roundBondProofHash: null, at: 4400 },
      ],
    });
    expect(caught(() => reduceCourtConfirmationMachine(skewedPending, {
      type: 'open_ladder_round', round: 4, voteDeadline: 9000, now: 5000,
    })).message).toMatch(/round counters disagree/);
  });

  it('r10-4: the only transitions that ACCEPT a skew lock nothing in', () => {
    // The sweep the brief asks for: hand the skewed snapshot every event in the
    // grammar and show the accepted ones are exactly the ones that move no value
    // (a clock tick, an abort, a fee-id append, a concede that finalize then
    // refuses). Anything that decides something refuses.
    const base = resolvedRoundOne();
    const skewed = (phase: string) => forge(base, {
      ladderRound: 3, phase, ladder: { ...base.ladder, round: 2 },
    });
    const events: Array<[string, CourtConfirmationMachineEvent, string]> = [
      ['tick', { type: 'tick', now: 5000 }, 'round_resolved'],
      ['abort', { type: 'abort', reason: 'host' }, 'round_resolved'],
      ['record_fee', { type: 'record_fee', feeEventId: hid('zf'), now: 5000 }, 'round_resolved'],
      ['concede', { type: 'concede', now: 5000 }, 'round_resolved'],
      ['accept_confirmation', {
        type: 'accept_confirmation', idx: 1, confirmHash: hexId('1'), eventId: hid('z1'), now: 5000,
      }, 'round_resolved'],
      ['accept_mass_vote', {
        type: 'accept_mass_vote', idx: 1, outcome: 'YES', eventId: hid('z2'), now: 5000,
      }, 'ladder_vote_open'],
      ['close_ladder_round', { type: 'close_ladder_round', now: 5000 }, 'ladder_vote_open'],
      ['resolve_round', { type: 'resolve_round', now: 5000 }, 'ladder_vote_closed'],
      ['escalate', {
        type: 'escalate', authority: 'challenger', challengerIdx: 2,
        challengerPubkey: CHALLENGER_PUBKEY, requestHash: hexId('3'),
        bondProofHash: MEMBERSHIP_BOND, roundIndex: 4, now: 5000,
      }, 'round_resolved'],
      ['open_ladder_round', {
        type: 'open_ladder_round', round: 4, voteDeadline: 9000, now: 5000,
      }, 'ladder_pending'],
      ['finalize', { type: 'finalize', now: 5000 }, 'fee_settlement'],
    ];
    const accepted: string[] = [];
    for (const [name, event, phase] of events) {
      try {
        reduceCourtConfirmationMachine(skewed(phase), event);
        accepted.push(name);
      } catch {
        // refused — the point of the sweep
      }
    }
    // The accepted set is the set that locks no VALUE in: a clock tick, an
    // abort, a fee-id append, a `concede` (the barrier that matters — finalize —
    // refuses it, asserted above) and `close_ladder_round`, which freezes a vote
    // ledger that `resolve_round` re-derives and re-checks before any outcome is
    // written. Everything that decides something refuses the snapshot.
    expect(accepted.sort()).toEqual(['abort', 'close_ladder_round', 'concede', 'record_fee', 'tick']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — the byte-differential pin (r9-5 attacked)
// ─────────────────────────────────────────────────────────────────────────────

describe('T5 (r9-5 attacked) — is the byte-differential pin actually strong?', () => {
  /** The preimage is nine NUL-joined segments in a DECLARED order. */
  function segments(req: CourtEscalationRequest): string[] {
    return courtEscalationRequestPreimage(req).split('\u0000');
  }

  it('the pin has TEETH: lossy, folding and re-joining encoders all fail it', () => {
    // r9-5 replaced a digest sweep with a preimage differential, which is blind
    // to what the differential does not vary. The round-10 pin therefore pins the
    // preimage's STRUCTURE, not only a pair of values: nine segments, the id
    // EXACTLY as segment 0, the declared order, and the '-' sentinel for an
    // absent round bond. Measured against mutated copies of the canonicaliser
    // (`docs/REVIEW_ROUND_10.md` §5), this fails every mutation that changes a
    // field's bytes, and the KAT below fails the one that does not (the domain).
    const honest = segments(request());
    expect(honest).toHaveLength(9);
    expect(honest[0]).toBe(CASE_ID);
    expect(honest.slice(1)).toEqual([
      '1',
      CHALLENGER_PUBKEY,
      BOND_TXID,
      MEMBERSHIP_BOND,
      ROUND_BOND,
      EVENT_ID,
      '1790000000',
      '0',
    ]);
    expect(segments(request({ roundBondProofHash: null }))[5]).toBe('-');
    // A LOSSY encoder (the id truncated before hashing) breaks segment 0.
    const lossy = (r: CourtEscalationRequest): string[] =>
      [r.caseId.slice(0, 8), ...segments(r).slice(1)];
    expect(() => expect(lossy(request())[0]).toBe(CASE_ID)).toThrow();
    expect(lossy(request())[0]).not.toBe(CASE_ID);
    // A CASE-FOLDING encoder breaks it for any id with case to lose.
    const folded = (r: CourtEscalationRequest): string[] =>
      [r.caseId.toLowerCase(), ...segments(r).slice(1)];
    const mixed = request({ caseId: 'court:Market-A:1' });
    expect(folded(mixed)[0]).not.toBe('court:Market-A:1');
    // A RE-JOINING encoder is not nine segments at all.
    expect(courtEscalationRequestPreimage(request()).split('\u0001')).toHaveLength(1);
    // …and the dangerous pairs the r9 pin compares still differ byte-for-byte,
    // including the classes this round probed (format characters, whitespace that
    // is refused, astral text vs its replacement character).
    const pairs: Array<[string, string]> = [
      ['court:caf\u00e9:1', 'court:cafe\u0301:1'],
      ['court:X:1', 'court:X:2'],
      ['court:X:1a', 'court:X:1A'],
      [`${CASE_ID}\u200b`, `${CASE_ID}\u200c`],
      ['court:X:1\ufffd', 'court:X:1\ufffe'],
      ['a\ud83d\ude00b', 'a\ufffdb'],
    ];
    for (const [left, right] of pairs) {
      const a = utf8(courtEscalationRequestPreimage(buildCourtEscalationRequest({
        ...request(), caseId: left,
      })));
      const b = utf8(courtEscalationRequestPreimage(buildCourtEscalationRequest({
        ...request(), caseId: right,
      })));
      expect(a, `${left} vs ${right}`).not.toEqual(b);
      expect(segments(buildCourtEscalationRequest({ ...request(), caseId: left }))[0]).toBe(left);
    }
  });

  it('a DOMAIN-ONLY change fails the pin: the domain is re-derived, not read back', () => {
    // The measured gap: the r9-5 differential PASSES on a canonicaliser whose
    // only change is the digest domain (a v2 → v3 bump), because the preimage is
    // identical. The pin therefore pins the DOMAIN independently — the digest is
    // recomputed here from the documented literal, the 0x00 separator and the
    // preimage, so the module's constant cannot drift past this test.
    expect(COURT_ESCALATION_REQUEST_DOMAIN).toBe('BAO-Court/Escalation/Request/v2');
    const req = request();
    const domain = utf8('BAO-Court/Escalation/Request/v2');
    const body = utf8(courtEscalationRequestPreimage(req));
    const input = new Uint8Array(domain.length + 1 + body.length);
    input.set(domain, 0);
    input[domain.length] = 0x00;
    input.set(body, domain.length + 1);
    expect(hashCourtEscalationRequest(req)).toBe(bytesToHex(sha256(input)));
    // KNOWN ANSWER: the same digest `__tests__/escalationRequestWire.test.ts`
    // pins for the host's byte-identical implementation. Two pins, one constant —
    // a domain, separator, order or encoding change fails both.
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
    // A one-byte change ANYWHERE in the preimage changes the digest (the pin's
    // power over the digest, which the r9 sweep never had).
    const bumped = buildCourtEscalationRequest({ ...req, signedAtSec: req.signedAtSec + 1 });
    expect(hashCourtEscalationRequest(bumped)).not.toBe(hashCourtEscalationRequest(req));
  });

  it('the 2 000-id sweep is kept as a smoke test, not as the injectivity proof', () => {
    const preimages = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      preimages.add(courtEscalationRequestPreimage(buildCourtEscalationRequest({
        ...request(), caseId: `court:market-r50:${i}`,
      })));
    }
    expect(preimages.size).toBe(2_000);
    // The sweep cannot fail for a reason a caseId guard can affect (every id is
    // already distinct), which is why the structural pin above carries the claim.
    expect(() => buildCourtEscalationRequest({ ...request(), caseId: `court:market-r50:0 ` }))
      .toThrow(/whitespace/);
  });
});
