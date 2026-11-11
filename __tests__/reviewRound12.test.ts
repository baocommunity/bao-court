// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Review round 12 — attacking the round-11 fixes (v0.15.1, `e489fe5`).
 *
 * Round 11 fixed three things by NARROWING A CHANNEL: it escaped the echo, it
 * validated the event shape before the signature, and it put the missed
 * `flag_clawback` reader behind the counter barrier. Round 12 attacks each fix
 * at the CLASS rather than at the site that was attacked:
 *
 *  T1  r11-1's escape is total over the two files it was written in
 *      (`courtEscalationRequest.ts`, `confirmationMachineCore.ts`) and NOT over
 *      the rest of the reducer: `confirmationMachineHandlers.ts` and
 *      `courtConfirmationMachine.ts` interpolate `state.phase`, counters,
 *      participant indices, outcomes and `event.type` VERBATIM into ~45
 *      refusals, `String(unknownType)` on the reducer's front door threw a raw
 *      `TypeError` for an object type, `${String(event.roundIndex)}` threw for
 *      the same reason, and `assertRoundCountersAgree` — the barrier r11-3
 *      extended — accepted two counters forged to the SAME non-integer, which
 *      `flag_clawback` then PERSISTED (r12-1, FIXED);
 *  T1  the helper's own edges: the clip was documented as 64 characters but
 *      returned `body + '…'` (65), the budget counts UTF-16 units for astral
 *      characters, the escape is not injective (a literal `\u{1b}` renders like
 *      an escaped ESC), and double-quoting is idempotent (r12-2, FIXED for the
 *      bound, CLOSED-BY-DESIGN for the ambiguity);
 *  T2  the r11-2 shape gate, fuzzed from its own accepted grammar (20 000
 *      shapes) and probed in the reverse direction for over-strictness
 *      (r12-3, BLOCKED);
 *  T3  the r11-3 clawback barrier, swept over EVERY ladder-writing handler and
 *      probed for a legal interleaving it now refuses (r12-4, BLOCKED +
 *      the r12-1 hardening);
 *  T4  the r11-5 divergence — `beta: 0.3` (cap 1) vs `beta: 3 * 0.1` (cap 2) —
 *      decided rather than deferred (r12-5, CLOSED-BY-DESIGN; the fix the
 *      deferral named is arithmetically impossible without a LOSSY parameter
 *      domain, and the campaign's canonicalisation rule is already satisfied:
 *      the FIELD is canonicalised once, the two inputs are two doubles).
 *
 * `docs/REVIEW_ROUND_12.md` carries the repro, the disposition and the measured
 * numbers. Every test here fails on `e489fe5` except the ones that pin a
 * BLOCKED target (a finding that is not a fix must not need one).
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';

import { quoteCounter, quoteWireUnknown, quoteWireValue } from '../courtEcho';
import {
  buildCourtEscalationRequest,
  courtEscalationRequestSignedContent,
  escalationRequestBindingFromSignedEvent,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
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
import {
  DEFAULT_LADDER_ROUNDS,
  MAX_LADDER_ROUNDS,
  assertRoundCountersAgree,
} from '../confirmationMachineCore';
import {
  deriveLadderFlipRound,
  deriveMaxLadderRounds,
  ladderCapWithinBound,
} from '../ladderEconomics';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures (the same honest ladder the round-11 file builds, so the two rounds
// attack the same states)
// ─────────────────────────────────────────────────────────────────────────────

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

const BINDING = { caseId: CASE_ID, authenticatedPubkey: CHALLENGER_PUBKEY };

/** Characters a log line must never carry verbatim. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** A forged line a hostile value tries to write into a log. */
const HOSTILE = '3\nESCALATION ACCEPTED for case court:target:1';

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

function confirmOpen(): CourtConfirmationMachineState {
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
  return reduceCourtConfirmationMachine(s, {
    type: 'accept_confirmation',
    idx: 1,
    confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 1 }),
    eventId: hid('c1'),
    now: 101,
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

/** Open a round, vote it, close it — but do NOT resolve it. */
function closedRound(
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
  return reduceCourtConfirmationMachine(next, { type: 'close_ladder_round', now: base + 1000 });
}

function voteRound(
  s: CourtConfirmationMachineState,
  round: number,
  outcome: string,
  base: number,
): CourtConfirmationMachineState {
  return reduceCourtConfirmationMachine(
    closedRound(s, round, outcome, base), { type: 'resolve_round', now: base + 1100 },
  );
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

/** `resolvedRoundOne` escalated: phase `ladder_pending`, both counters at 1. */
function ladderPending(): CourtConfirmationMachineState {
  return reduceCourtConfirmationMachine(resolvedRoundOne(), {
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
}

/** The honest three-round ladder: rounds 1/2/3 resolve NO / YES / NO; fee_settlement. */
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

/** Assert a refusal is this package's typed error and carries no raw control char. */
function expectTypedOneLine(fn: () => unknown, label: string): Error {
  const err = caught(fn);
  expect(err.constructor.name, label).toBe('CourtConfirmationTransitionError');
  expect(err, label).toBeInstanceOf(CourtConfirmationTransitionError);
  expect(err.message, label).not.toMatch(UNSAFE);
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// T1a — the STATIC totality sweep (r12-1)
//
// The point of this test is that it is MECHANICAL: it does not know the sites,
// it discovers the files that construct the typed error and then refuses any
// interpolation of a value into a refusal unless it is a `quote*` call or a
// provably-safe form. A future site cannot regress silently.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ERROR_CONSTRUCTOR = 'new CourtConfirmationTransitionError(';

/**
 * Walk `text` from `start` (just past an opening bracket) to the matching
 * closing bracket, understanding quoted strings, template literals with nested
 * `${…}`, and comments. Returns the index of the closing bracket.
 */
function scanBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') {
          i = scanBalanced(text, i + 2, '{', '}');
          continue;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      i = i < 0 ? text.length : i + 2;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`unbalanced ${open}${close} starting at ${start}`);
}

/** Index just past the template literal that starts at `start` (a backtick). */
function skipTemplate(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '`') {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$' && text[i + 1] === '{') {
      i = scanBalanced(text, i + 2, '{', '}') + 1;
      continue;
    }
    i += 1;
  }
  return i + 1;
}

/** Every `${…}` expression inside the backtick template that starts at `start`. */
function templateExpressions(text: string, start: number): Array<{ expr: string; at: number }> {
  const out: Array<{ expr: string; at: number }> = [];
  let i = start + 1;
  while (i < text.length && text[i] !== '`') {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$' && text[i + 1] === '{') {
      const end = scanBalanced(text, i + 2, '{', '}');
      out.push({ expr: text.slice(i + 2, end), at: i });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Every interpolation of a value into a typed refusal (or a state `reason`). */
function refusalInterpolations(text: string): Array<{ expr: string; at: number }> {
  const out: Array<{ expr: string; at: number }> = [];
  // (a) every template literal inside a CourtConfirmationTransitionError( … ) call
  let from = 0;
  for (;;) {
    const at = text.indexOf(ERROR_CONSTRUCTOR, from);
    if (at < 0) break;
    const open = at + ERROR_CONSTRUCTOR.length;
    const end = scanBalanced(text, open, '(', ')');
    let i = open;
    while (i < end) {
      if (text[i] === '`') {
        out.push(...templateExpressions(text, i));
        i = skipTemplate(text, i);
        continue;
      }
      i += 1;
    }
    from = end + 1;
  }
  // (b) every template literal assigned to `reason:` (a state a host logs)
  for (const match of text.matchAll(/reason:\s*`/g)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    out.push(...templateExpressions(text, start));
  }
  return out;
}

/**
 * The allowlist. EVERY entry is a form in which no caller- or snapshot-supplied
 * value can reach the message: a `quote*` call, a module constant, a type name,
 * a numeric literal, or an array length.
 */
const SAFE_INTERPOLATION: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(quoteWireValue|quoteWireUnknown|quoteCounter)\(/, 'escaped by the canonical helper'],
  [/^[A-Z][A-Z0-9_]{2,}$/, 'a module constant'],
  [/^typeof\s+[\w.$]+$/, 'a type name (typeof), never a value'],
  [/^\d+$/, 'a numeric literal'],
  [/^[\w.$]+\.length$/, 'an array length (a number, whatever the array holds)'],
];

function violationsIn(text: string): Array<{ expr: string; at: number }> {
  return refusalInterpolations(text)
    .filter(({ expr }) => !SAFE_INTERPOLATION.some(([re]) => re.test(expr.trim())))
    .map(({ expr, at }) => ({ expr: expr.trim(), at }));
}

/** The package sources that construct the typed error, discovered not listed. */
function refusalSources(): Array<{ name: string; text: string }> {
  return readdirSync(ROOT)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map((name) => ({ name, text: readFileSync(join(ROOT, name), 'utf8') }))
    .filter(({ text }) => text.includes(ERROR_CONSTRUCTOR));
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

describe('T1 (r11-1 attacked at the class) — the echo must be total over the reducer', () => {
  it('r12-1: the static sweep — every refusal interpolation is quoted or provably safe', () => {
    // MEASURED ON e489fe5: the sweep reports 66 raw interpolations —
    // `confirmationMachineHandlers.ts` 44 (`state.phase` × 15, the counters, the
    // participant indices, the outcomes, `String(event.roundIndex)`),
    // `courtConfirmationMachine.ts` 3 (`event.type` and `String(unknownType)` on
    // the front door), `confirmationMachineCore.ts` 9 (including
    // `state.ladderRound` in the log-completeness refusal, which round 11's
    // sweep table had implied was safe), and `courtEscalationRequest.ts` 10 that
    // are literals by CONVENTION only (a `field`/`label` parameter, a validated
    // round, two hex32 ids) — harmless today, unenforced tomorrow.
    const sources = refusalSources();
    expect(sources.map((s) => s.name).sort()).toEqual([
      'confirmationMachineCore.ts',
      'confirmationMachineHandlers.ts',
      'courtConfirmationMachine.ts',
      'courtEscalationRequest.ts',
    ]);
    const violations: string[] = [];
    for (const { name, text } of sources) {
      for (const { expr, at } of violationsIn(text)) {
        violations.push(`${name}:${lineOf(text, at)}  \${${expr}}`);
      }
    }
    expect(violations, `unquoted refusal interpolations:\n${violations.join('\n')}`).toEqual([]);
    // The sweep is not vacuous: the files really do interpolate (a refactor that
    // removed every message interpolation would otherwise make this pass).
    const total = sources.reduce((n, s) => n + refusalInterpolations(s.text).length, 0);
    expect(total).toBeGreaterThan(40);
    // ONE implementation: a second escape helper would drift from this one, so
    // the module that DEFINES the helpers must be exactly the file they live in.
    const definers = readdirSync(ROOT)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /function quoteWire(Value|Unknown)|function quoteCounter/.test(readFileSync(join(ROOT, name), 'utf8')));
    expect(definers.sort()).toEqual(['courtEcho.ts']);
  });

  it('r12-1: the sweep has teeth — it flags the shapes the round-11 fix left behind', () => {
    // A checker that matches everything would pass the sweep above. Feed it the
    // exact pre-fix lines.
    const preFix = `
      throw new CourtConfirmationTransitionError(\`cannot abort confirmation from \${state.phase}\`);
      throw new CourtConfirmationTransitionError(
        \`escalation roundIndex \${String(event.roundIndex)} does not open \${expectedRound}\`,
      );
      throw new CourtConfirmationTransitionError(\`unknown: \${quoteWireUnknown(x)}\`);
      failure: { phase: 'expired', reason: \`The \${state.phase} deadline passed.\` },
    `;
    const found = violationsIn(preFix).map((v) => v.expr);
    expect(found).toEqual(['state.phase', 'String(event.roundIndex)', 'expectedRound', 'state.phase']);
  });

  it('r12-1: the reducer\'s front door refuses a hostile event type with a TYPED error', () => {
    // MEASURED ON e489fe5:
    //   { type: Object.create(null) }          -> TypeError: Cannot convert object to primitive value
    //   { type: { toString() { throw … } } }   -> the caller's own Error ("boom")
    //   { type: "boom\\nESCALATION ACCEPTED…" } -> the newline, verbatim, in the message
    // — the exact class r11-1 fixed one module over.
    const state = challengeWindow();
    const hostileTypes: ReadonlyArray<readonly [string, unknown]> = [
      ['null-prototype object', Object.create(null)],
      ['throwing toString', { toString() { throw new Error('boom'); } }],
      ['symbol', Symbol('t')],
      ['hostile string', `boom${HOSTILE}`],
    ];
    for (const [label, type] of hostileTypes) {
      const err = expectTypedOneLine(
        () => reduceCourtConfirmationMachine(state, { type, now: 1200 } as unknown as CourtConfirmationMachineEvent),
        label,
      );
      expect(err.message, label).toMatch(/unknown confirmation event type/);
      expect(err.message, label).not.toContain('boom\u0000');
    }
    // An object is described; a string is escaped, not re-interpreted.
    expect(expectTypedOneLine(
      () => reduceCourtConfirmationMachine(state, { type: Object.create(null), now: 1200 } as never),
      'object',
    ).message).toContain('<object>');
    expect(expectTypedOneLine(
      () => reduceCourtConfirmationMachine(state, { type: `boom${HOSTILE}`, now: 1200 } as never),
      'string',
    ).message).toContain('boom3\\u{a}ESCALATION ACCEPTED');
    // A TERMINAL snapshot echoes the event type too.
    expect(expectTypedOneLine(
      () => reduceCourtConfirmationMachine(
        { ...state, phase: 'final' } as CourtConfirmationMachineState,
        { type: `boom${HOSTILE}`, now: 1200 } as never,
      ),
      'terminal',
    ).message).toMatch(/cannot process .* after final/);
  });

  it('r12-1: a hostile SNAPSHOT cannot forge a line through a handler refusal', () => {
    // `state.phase` is the snapshot value round 11 called out; here it is echoed
    // by 15 handler refusals. Each must come back as ONE line.
    const state = challengeWindow();
    const phases = [`confirm_open${HOSTILE}`, 'confirm_closed', 'ladder_vote_open'];
    const events: ReadonlyArray<readonly [string, CourtConfirmationMachineEvent]> = [
      ['accept_confirmation', { type: 'accept_confirmation', idx: 1, confirmHash: hid('0'), eventId: hid('1'), now: 1200 }],
      ['close_ladder_round', { type: 'close_ladder_round', now: 1200 }],
      ['finalize', { type: 'finalize', now: 1200 }],
      ['escalate', {
        type: 'escalate', authority: 'host', challengerIdx: null, challengerPubkey: null,
        requestHash: null, bondProofHash: null, roundIndex: 1, now: 1200,
      }],
    ];
    for (const phase of phases) {
      for (const [label, event] of events) {
        expectTypedOneLine(
          () => reduceCourtConfirmationMachine(forge(state, { phase }), event),
          `${phase} / ${label}`,
        );
      }
    }
    // The escalate refusal quotes the caller's `roundIndex` too.
    const roundIndexErr = expectTypedOneLine(
      () => reduceCourtConfirmationMachine(
        forge(resolvedRoundOne(), { phase: 'round_resolved' }),
        { type: 'escalate', authority: 'host', roundIndex: `1${HOSTILE}`, now: 3400 } as never,
      ),
      'roundIndex',
    );
    expect(roundIndexErr.message).toContain('roundIndex 13\\u{a}ESCALATION ACCEPTED');
    // …and an OBJECT roundIndex is described, not stringified (the r11-1 shape).
    expect(expectTypedOneLine(
      () => reduceCourtConfirmationMachine(
        forge(resolvedRoundOne(), { phase: 'round_resolved' }),
        { type: 'escalate', authority: 'host', roundIndex: Object.create(null), now: 3400 } as never,
      ),
      'roundIndex object',
    ).message).toContain('roundIndex <object>');
  });

  it('r12-1: two counters forged to the SAME non-integer are refused, never persisted', () => {
    // MEASURED ON e489fe5: `assertRoundCountersAgree` compared with `===`, so a
    // snapshot whose two counters were BOTH "3\nESCALATION ACCEPTED" passed the
    // barrier, and `flag_clawback` wrote it into the audit ledger:
    //   clawbackFlags: [{ idx: 1, reason: "late", round: "3\nESCALATION ACCEPTED…" }]
    // (r11's own probe forged only ONE side, so the pair disagreed and the
    // barrier fired — the shape that agrees was never tried.)
    const ladder = threeRoundLadder();
    for (const counter of [`"${HOSTILE}"`, '2.5', -1, null]) {
      const value = counter === `"${HOSTILE}"` ? HOSTILE : counter === 'null' ? null
        : counter === '-1' ? -1 : 2.5;
      const skew = forge(ladder, {
        ladderRound: value,
        ladder: { ...ladder.ladder!, round: value },
      });
      const err = expectTypedOneLine(
        () => reduceCourtConfirmationMachine(
          skew, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
        ),
        String(value),
      );
      expect(err.message).toMatch(/round counters disagree/);
      expect(err.message).toContain('<not an integer>');
      // Nothing was written: the refusal is before the record.
      expect(skew.clawbackFlags.filter((f) => f.reason === 'late fee')).toEqual([]);
      // The same forged state cannot reach `finalize` either.
      expectTypedOneLine(
        () => reduceCourtConfirmationMachine(skew, { type: 'finalize', now: 7000 }),
        `finalize ${String(value)}`,
      );
    }
    // A counter with no ladder is the mirror image of a skew (r12-1).
    const noLadder = expectTypedOneLine(
      () => reduceCourtConfirmationMachine(
        forge(threeRoundLadder(), { ladder: undefined }),
        { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
      ),
      'ladder removed',
    );
    expect(noLadder.message).toMatch(/ladderRound is 3 but no ladder round is open/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T1b — the helper itself (r12-2)
// ─────────────────────────────────────────────────────────────────────────────

/** The unique escaped form of one code point, as the helper writes it. */
const escapeOf = (ch: string): string => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`;

describe('T1b — the quote helper\'s own edges', () => {
  it('r12-2: the bound is 64 characters, MARKER INCLUDED, in code points and code units', () => {
    // Round 11 spent the budget on the escaped output but returned `body + '…'`,
    // so a clipped echo measured 65 characters against a documented 64.
    const values = [
      'a'.repeat(200),
      '\u200b'.repeat(80),                       // 8-character escapes
      '\u{1F600}'.repeat(80),                    // astral: 2 code units each
      `${'a'.repeat(30)}${'\u200b'.repeat(30)}${'\u{1F600}'.repeat(30)}`,
      `${'a'.repeat(61)}\u{1F600}`,              // a split BEFORE the astral char
      `${'a'.repeat(62)}\u{1F600}`,
    ];
    for (const value of values) {
      const echo = quoteWireValue(value);
      expect(echo.length, JSON.stringify(value.slice(0, 12))).toBeLessThanOrEqual(64);
      expect([...echo].length, JSON.stringify(value.slice(0, 12))).toBeLessThanOrEqual(64);
      expect(echo).not.toMatch(/\p{Cs}/u);
      // No truncated escape: every `\u{` is closed.
      expect((echo.match(/\\u\{/g) ?? []).length, JSON.stringify(value.slice(0, 12)))
        .toBe((echo.match(/\\u\{[0-9a-f]+\}/g) ?? []).length);
      // The result is always a PREFIX of the full escaped value, plus the marker.
      const full = [...value].map((ch) => (UNSAFE.test(ch) ? escapeOf(ch) : ch)).join('');
      expect(full.startsWith(echo.replace(/…$/, '')), JSON.stringify(value.slice(0, 12))).toBe(true);
    }
    // Astral characters are counted in UTF-16 units, so the clip is a code-unit
    // prefix and can never split a pair (the bound is tighter, never looser).
    expect(quoteWireValue('\u{1F600}'.repeat(40)).endsWith('…')).toBe(true);
    expect(quoteWireValue('\u{1F600}'.repeat(40))).not.toMatch(/\p{Cs}/u);
    // A short value is not clipped and carries no marker.
    expect(quoteWireValue('court:A')).toBe('court:A');
    expect(quoteWireValue('court:A')).not.toContain('…');
  });

  it('r12-2: double-quoting is IDEMPOTENT, and the marker is deliberately not injective', () => {
    // A value that is ALREADY an echo must survive being quoted again: two site
    // authors each quoting a message must not double-escape it.
    for (const value of ['a\u0007b', 'court:A', '\u200b', `x${'…'}`, '\\u{1b}']) {
      const once = quoteWireValue(value);
      expect(quoteWireValue(once), JSON.stringify(value)).toBe(once);
      expect(quoteWireUnknown(once), JSON.stringify(value)).toBe(once);
    }
    // NOT INJECTIVE, by design and pinned: an escaped ESC and a value that
    // literally spells the escape render identically, and a value ending in `…`
    // renders like a clip. The safe direction is what matters — neither output
    // can carry a control character — and the ambiguity only makes a hostile
    // value look MORE boring than it is.
    expect(quoteWireValue('\u001b]0;pwned')).toBe(quoteWireValue('\\u{1b}]0;pwned'));
    expect(quoteWireValue('court:A…')).toBe('court:A…');
    expect(quoteWireValue('court:A'.repeat(20))).toBe(`${'court:A'.repeat(9)}…`);
  });

  it('r12-2: a lone surrogate is escaped, never emitted', () => {
    // JSON allows an unpaired surrogate in a string, so a wire body can carry
    // one into a refusal (`parse` names an unknown field).
    const lonely = 'co\uD800urt';
    expect(quoteWireValue(lonely)).toBe(`co${escapeOf('\uD800')}urt`);
    expect(quoteWireValue(lonely)).not.toMatch(/\p{Cs}/u);
    // The same value as an unknown WIRE key: escaped on the way into the message.
    const err = expectTypedOneLine(
      () => parseCourtEscalationRequest(`{"caseId":"court:A","c\\ud800":1}`),
      'lone surrogate key',
    );
    expect(err.message).toContain('\\u{d800}');
    // A lone surrogate in a CASE ID is refused before any echo at all (r8-1:
    // the id must encode injectively).
    const idErr = expectTypedOneLine(
      () => buildCourtEscalationRequest({ ...request(), caseId: `court:A\uD800` }),
      'lone surrogate id',
    );
    expect(idErr.message).toMatch(/canonical UTF-8/);
  });

  it('r12-2: quoting is total over untyped values and never runs caller code', () => {
    let ran = false;
    const traps: unknown[] = [
      Object.create(null),
      { toString() { ran = true; throw new Error('boom'); } },
      Symbol('s'),
      10n,
      null,
      undefined,
      [],
      () => 1,
      1.5,
      true,
    ];
    for (const value of traps) {
      const quoted = quoteWireUnknown(value);
      expect(typeof quoted).toBe('string');
      expect(quoted).not.toMatch(UNSAFE);
    }
    expect(ran).toBe(false);
    expect(quoteWireUnknown(Object.create(null))).toBe('<object>');
    expect(quoteWireUnknown(Symbol('s'))).toBe('<symbol>');
    expect(quoteWireUnknown(10n)).toBe('10');
    // The counter helper DESCRIBES anything that is not a round number.
    for (const value of [1.5, -1, '3', null, {}, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(quoteCounter(value), String(value)).toBe('<not an integer>');
    }
    expect(quoteCounter(0)).toBe('0');
    expect(quoteCounter(MAX_LADDER_ROUNDS)).toBe(String(MAX_LADDER_ROUNDS));
    // `quoteWireValue` is total at runtime too: a field the TYPE declares as a
    // string can be `undefined` on a restored record (measured on the r12-1 fix
    // itself — `bond.bondTxid` after a legacy snapshot drops the column, which
    // made a refusal throw `value is not iterable`).
    for (const value of [undefined, null, 2, {}, Symbol('s')] as unknown[]) {
      const quoted = quoteWireValue(value as string);
      expect(typeof quoted, String(value)).toBe('string');
      expect(quoted, String(value)).not.toMatch(UNSAFE);
    }
    expect(quoteWireValue(undefined as unknown as string)).toBe('undefined');
    expect(quoteWireValue(2 as unknown as string)).toBe('2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — the event-shape gate, from its own grammar (r12-3)
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = generateSecretKey();
const AUTHOR = getPublicKey(SECRET);

/** Deterministic PRNG (no Math.random: the corpus must be reproducible). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex32From(rnd: () => number): string {
  let out = '';
  for (let i = 0; i < 64; i += 1) out += '0123456789abcdef'[Math.floor(rnd() * 16)];
  return out;
}

/**
 * A random event SHAPE from the validator's own accepted grammar: every field is
 * of the type the gate admits, only the VALUES are hostile/arbitrary.
 */
function randomShape(rnd: () => number): CourtEscalationRequestEvent {
  const kinds = [0, 1, 39009, 22242, Number.MAX_SAFE_INTEGER];
  const createdAts = [0, 1, 1_790_000_000, Number.MAX_SAFE_INTEGER];
  const contents = ['', 'x', '{}', 'court:market-r50:1', '\n\u202e\u0000', 'x'.repeat(300)];
  const tagSets: string[][][] = [
    [],
    [['t', 'escalation']],
    [['e', hexId('a')]],
    [['']],
    [['a', 'b', 'c']],
    Array.from({ length: 8 }, (_, i) => [`k${i}`, 'v']),
    [['t', '\u0000\n']],
  ];
  return {
    kind: kinds[Math.floor(rnd() * kinds.length)],
    pubkey: hex32From(rnd),
    created_at: createdAts[Math.floor(rnd() * createdAts.length)],
    tags: tagSets[Math.floor(rnd() * tagSets.length)],
    content: contents[Math.floor(rnd() * contents.length)],
    id: hex32From(rnd),
    sig: hex32From(rnd) + hex32From(rnd),
  };
}

describe('T2 (r11-2 attacked) — the shape gate, fuzzed from its own grammar', () => {
  it('r12-3: 20 000 grammatical shapes produce only TYPED refusals (and verifyEvent never throws)', () => {
    // The r11-2 fix is "shape first, then verifyEvent". The fuzz asserts the
    // property that matters: no shape the gate ADMITS can make either entry
    // throw anything but this package's typed error — including the five
    // thousand shapes that reach the crypto path with a well-shaped but
    // unsigned signature.
    const rnd = mulberry32(0x12_03);
    let reachedCrypto = 0;
    let typedRefusals = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const shape = randomShape(rnd);
      // (a) verifyEvent is TOLERANT: it returns a boolean for every shape.
      let verdict: unknown;
      expect(() => { verdict = verifyEvent(shape as Parameters<typeof verifyEvent>[0]); }).not.toThrow();
      expect(typeof verdict).toBe('boolean');
      // (b) the binder refuses with its own error type, never a raw throw.
      //     Half the corpus is bound to its own event id, so it reaches the
      //     signature check (and fails there, because a random sig cannot sign).
      const boundToSelf = i % 2 === 0;
      const req = request(boundToSelf ? { eventId: shape.id } : {});
      let err: Error | undefined;
      try {
        escalationRequestBindingFromSignedEvent(req, shape, 39009);
      } catch (thrown) {
        err = thrown as Error;
      }
      expect(err, `shape #${i}`).toBeDefined();
      expect(err!.constructor.name, `shape #${i}: ${err!.message}`).toBe('CourtConfirmationTransitionError');
      expect(err!.message, `shape #${i}`).not.toMatch(UNSAFE);
      typedRefusals += 1;
      if (err!.message.startsWith('escalation request event signature does not verify')) reachedCrypto += 1;
    }
    expect(typedRefusals).toBe(20_000);
    expect(reachedCrypto).toBeGreaterThan(1_500);
  }, 60_000);

  it('r12-3: every LEGAL nostr shape binds (the gate is not over-strict)', () => {
    // The reverse direction: shapes `verifyEvent` would accept because they are
    // genuinely SIGNED events, including the edges of the gate's own grammar
    // (epoch timestamp, empty tags, kind 0, unicode/newline content, extra
    // fields). Each must reach the binding, not a shape refusal.
    const shapes: Array<{ label: string; kind: number; created_at: number; tags: string[][]; content: string }> = [
      { label: 'minimal kind 0', kind: 0, created_at: 0, tags: [], content: '' },
      { label: 'kind 1, empty tag values', kind: 1, created_at: 0, tags: [['', '']], content: 'x' },
      { label: 'route kind, unicode content', kind: 39009, created_at: 1, tags: [['t', 'x']], content: '\n\u202e😀' },
      { label: 'many tags', kind: 39009, created_at: 1_790_000_000, tags: Array.from({ length: 32 }, (_, i) => [`k${i}`, 'v']), content: 'y'.repeat(400) },
    ];
    for (const shape of shapes) {
      const signed = finalizeEvent({
        kind: shape.kind, created_at: shape.created_at, tags: shape.tags, content: shape.content,
      }, SECRET) as unknown as CourtEscalationRequestEvent;
      const draft = request({ challengerPubkey: AUTHOR, signedAtSec: shape.created_at, eventId: hexId('0') });
      const content = courtEscalationRequestSignedContent(draft);
      const event = finalizeEvent({
        kind: shape.kind, created_at: shape.created_at, tags: shape.tags, content,
      }, SECRET) as unknown as CourtEscalationRequestEvent;
      const bound = buildCourtEscalationRequest({ ...draft, eventId: event.id });
      expect(
        escalationRequestBindingFromSignedEvent(bound, event, shape.kind),
        shape.label,
      ).toEqual({ caseId: CASE_ID, authenticatedPubkey: AUTHOR });
      // Extra (unsigned-by-this-wire) fields on the event are ignored, not a
      // shape refusal: the binding reads the seven signed fields only.
      const withExtras = { ...event, extra: 'x', seen_at: 1 } as unknown as CourtEscalationRequestEvent;
      expect(
        escalationRequestBindingFromSignedEvent(bound, withExtras, shape.kind),
        `${shape.label} + extra fields`,
      ).toEqual({ caseId: CASE_ID, authenticatedPubkey: AUTHOR });
      // …and the signed pair really is what nostr-tools verifies.
      expect(verifyEvent(event as Parameters<typeof verifyEvent>[0]), shape.label).toBe(true);
    }
  });

  it('r12-3: the narrowings are the FIELD DOMAIN, not an accidental shape refusal', () => {
    // A signed event with a negative `created_at` or a fractional `kind` DOES
    // verify under nostr-tools (the id commits to the JSON), so this is real
    // over-strictness — deliberate, typed, and named: the request's
    // `signedAtSec` is a non-negative unix second and the kind is the route's
    // own constant, so neither value can be legal for THIS wire. Pinned so the
    // refusal cannot drift into a silent shape rejection.
    const negative = finalizeEvent({
      kind: 39009, created_at: -1, tags: [], content: 'x',
    }, SECRET) as unknown as CourtEscalationRequestEvent;
    expect(verifyEvent(negative as Parameters<typeof verifyEvent>[0])).toBe(true);
    const createdAtErr = expectTypedOneLine(
      () => escalationRequestBindingFromSignedEvent(
        request({ eventId: negative.id }), negative, 39009,
      ),
      'negative created_at',
    );
    expect(createdAtErr.message).toMatch(/created_at must be a non-negative safe integer/);

    const fractional = finalizeEvent({
      kind: 1.5, created_at: 1, tags: [], content: 'x',
    }, SECRET) as unknown as CourtEscalationRequestEvent;
    expect(verifyEvent(fractional as Parameters<typeof verifyEvent>[0])).toBe(true);
    const kindErr = expectTypedOneLine(
      () => escalationRequestBindingFromSignedEvent(
        request({ eventId: fractional.id }), fractional, 39009,
      ),
      'fractional kind',
    );
    expect(kindErr.message).toMatch(/kind must be a non-negative safe integer/);
    // An uppercase spelling of a VALID signature: nostr-tools ACCEPTS it (same
    // bytes, other spelling) and the gate refuses it, which is the canonical
    // encoding rule this wire already applies to ids (r9-1: validate, never
    // fold). Measured, not assumed — and typed, so a host can route it.
    const atOne = finalizeEvent({ kind: 39009, created_at: 1, tags: [], content: 'x' }, SECRET);
    const clean = {
      kind: atOne.kind,
      pubkey: atOne.pubkey,
      created_at: atOne.created_at,
      tags: atOne.tags,
      content: atOne.content,
      id: atOne.id,
    };
    const uppercaseSig = { ...clean, sig: atOne.sig.toUpperCase() } as unknown as CourtEscalationRequestEvent;
    expect(verifyEvent(uppercaseSig as Parameters<typeof verifyEvent>[0])).toBe(true);
    expect(expectTypedOneLine(
      () => escalationRequestBindingFromSignedEvent(
        request({ eventId: clean.id }), uppercaseSig, 39009,
      ),
      'uppercase sig',
    ).message).toMatch(/signature must be 64-byte lowercase hex/);
  });

  it('r12-3: nostr-tools memoises its verdict ON the object — the rebuild is load-bearing', () => {
    // `finalizeEvent` marks the object it returns with a `verified: true` SYMBOL,
    // and object spread copies symbol-keyed properties. So `{ ...validEvent,
    // sig: 'ff…' }` is an event with a one-byte-forged signature that
    // `verifyEvent` reports as VALID — measured here. The binder refuses it only
    // because it REBUILDS a seven-field plain object before verifying (the
    // r10-3 rationale, now a measured pin): a "the object is already verified"
    // shortcut would accept a forged signature on a real id.
    const draft = request({ challengerPubkey: AUTHOR, eventId: hexId('0') });
    const content = courtEscalationRequestSignedContent(draft);
    const honest = finalizeEvent({ kind: 39009, created_at: 1_790_000_000, tags: [], content }, SECRET);
    const bound = buildCourtEscalationRequest({ ...draft, eventId: honest.id });
    expect(escalationRequestBindingFromSignedEvent(
      bound, honest as unknown as CourtEscalationRequestEvent, 39009,
    )).toEqual({ caseId: CASE_ID, authenticatedPubkey: AUTHOR });
    // The trap: same content and id, a DIFFERENT (invalid) signature, and the
    // memoised verdict riding along on the spread.
    const forged = { ...honest, sig: 'f'.repeat(128) } as unknown as CourtEscalationRequestEvent;
    expect(verifyEvent(forged as Parameters<typeof verifyEvent>[0]), 'memoised verdict').toBe(true);
    expect(expectTypedOneLine(
      () => escalationRequestBindingFromSignedEvent(bound, forged, 39009),
      'forged sig with memoised verdict',
    ).message).toMatch(/signature does not verify/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — the clawback barrier, swept over every ladder writer (r12-4)
// ─────────────────────────────────────────────────────────────────────────────

/** A challenged case parked at `ladder_vote_closed` for round 1. */
function firstRoundClosed(): CourtConfirmationMachineState {
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
  return closedRound(s, 1, 'NO', 2050);
}

/** A never-challenged case: the proposal stands, there is NO ladder at all. */
function neverChallenged(): CourtConfirmationMachineState {
  return reduceCourtConfirmationMachine(challengeWindow(), {
    type: 'close_challenge_window', now: 2000,
  });
}

describe('T3 (r11-3 attacked) — every ladder writer, and the ordering the barrier allows', () => {
  it('r12-4: every handler that PERSISTS a round is behind the barrier', () => {
    // The r11-3 fix put `flag_clawback` behind it. The sweep is the invariant:
    // for each writer, a snapshot whose two counters are forged-but-EQUAL must
    // be refused by the barrier BEFORE the record is written — at the writer's
    // OWN phase, so the phase check cannot be what refuses it.
    const writers: ReadonlyArray<readonly [string, CourtConfirmationMachineState, CourtConfirmationMachineEvent]> = [
      ['open_ladder_round', ladderPending(), { type: 'open_ladder_round', round: 2, voteDeadline: 5000, now: 3400 }],
      ['escalate', resolvedRoundOne(), {
        type: 'escalate', authority: 'challenger', challengerIdx: 2, challengerPubkey: CHALLENGER_PUBKEY,
        requestHash: hid('r2'), bondProofHash: MEMBERSHIP_BOND, roundBondProofHash: hid('b9'), roundIndex: 2, now: 3400,
      }],
      ['resolve_round', firstRoundClosed(), { type: 'resolve_round', now: 3200 }],
      ['flag_clawback', threeRoundLadder(), { type: 'flag_clawback', idx: 1, reason: 'late', now: 7000 }],
      ['finalize', threeRoundLadder(), { type: 'finalize', now: 7000 }],
    ];
    for (const [label, honest, event] of writers) {
      const before = honest.ladderRound;
      const skew = forge(honest, {
        ladderRound: HOSTILE,
        ladder: { ...honest.ladder!, round: HOSTILE },
      });
      const err = expectTypedOneLine(
        () => reduceCourtConfirmationMachine(skew, event),
        label,
      );
      expect(err.message, label).toMatch(/round counters disagree/);
      // Nothing was written (the refusal is before the record) and the honest
      // state is untouched by the probe.
      expect(skew.clawbackFlags, label).toEqual(honest.clawbackFlags);
      expect(skew.outcomeHistory, label).toEqual(honest.outcomeHistory);
      expect(skew.escalationLog, label).toEqual(honest.escalationLog);
      // …and the same writer still works on the HONEST state (over-strictness
      // control: five writers, five legal paths that must not have been narrowed).
      expect(() => reduceCourtConfirmationMachine(honest, event), label).not.toThrow();
      expect(before).toBe(honest.ladderRound);
    }
  });

  it('r12-4: no handler outside that list writes a round, and none of them heals one', () => {
    // The independence half: a transition that does not consume a counter must
    // not silently rewrite it (the `open_ladder_round` heal round 10 closed) and
    // must not be refused by the barrier.
    const cases: ReadonlyArray<readonly [string, CourtConfirmationMachineState, CourtConfirmationMachineEvent]> = [
      ['accept_confirmation', confirmOpen(), { type: 'accept_confirmation', idx: 3, confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx: 3 }), eventId: hid('c3'), now: 200 }],
      ['record_fee', resolvedRoundOne(), { type: 'record_fee', feeEventId: hid('f1'), now: 3400 }],
      ['concede', resolvedRoundOne(), { type: 'concede', now: 3400 }],
      ['abort', resolvedRoundOne(), { type: 'abort', reason: 'operator' }],
      ['tick', resolvedRoundOne(), { type: 'tick', now: 99_000 }],
    ];
    for (const [label, honest, event] of cases) {
      const skew = forge(honest, {
        ladderRound: HOSTILE,
        ladder: honest.ladder ? { ...honest.ladder, round: HOSTILE } : undefined,
      });
      const next = reduceCourtConfirmationMachine(skew, event);
      // The counter is NOT healed and no refusal was manufactured.
      expect(next.ladderRound, label).toBe(HOSTILE);
      if (next.ladder) expect(next.ladder.round, label).toBe(HOSTILE);
      expect(next.clawbackFlags, label).toEqual(skew.clawbackFlags);
      expect(next.outcomeHistory, label).toEqual(skew.outcomeHistory);
    }
  });

  it('r12-4: no legal interleaving is refused — the flag lands on the round the ladder is on', () => {
    // The ordering question: a clawback can only be flagged in `fee_settlement`,
    // which is reachable at the LAST round and after an early `concede`. Both are
    // legal and both must still flag; the barrier must not have narrowed the
    // accepted set to "the ladder finished".
    // (a) the full ladder: round 3 is the final round.
    const ladder = threeRoundLadder();
    expect(ladder.phase).toBe('fee_settlement');
    const late = reduceCourtConfirmationMachine(
      ladder, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
    );
    expect(late.clawbackFlags.filter((f) => f.reason === 'late fee'))
      .toEqual([{ idx: 1, reason: 'late fee', round: 3 }]);
    // (b) an EARLY concede at round 1 of a 3-round cap: fee_settlement with the
    // ladder still at round 1 — the flag names round 1, not the cap.
    const conceded = reduceCourtConfirmationMachine(
      resolvedRoundOne(), { type: 'concede', now: 3400 },
    );
    const early = reduceCourtConfirmationMachine(
      conceded, { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
    );
    expect(early.clawbackFlags.filter((f) => f.reason === 'late fee'))
      .toEqual([{ idx: 1, reason: 'late fee', round: 1 }]);
    // (c) a never-challenged case has NO ladder: the barrier returns early and
    // the flag records round 0, which is the honest answer ("no ladder round").
    const unchallenged = reduceCourtConfirmationMachine(
      neverChallenged(), { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 7000 },
    );
    expect(unchallenged.clawbackFlags.filter((f) => f.reason === 'late fee'))
      .toEqual([{ idx: 1, reason: 'late fee', round: 0 }]);
    // (d) every state the machine actually produced satisfies the invariant.
    for (const state of [challengeWindow(), ladderPending(), resolvedRoundOne(), threeRoundLadder(), conceded]) {
      expect(() => assertRoundCountersAgree(state), state.phase).not.toThrow();
    }
    // (e) the flag during a live round is refused by the PHASE, not the barrier —
    // the barrier did not take over a rule it does not own.
    const phaseErr = expectTypedOneLine(
      () => reduceCourtConfirmationMachine(
        firstRoundClosed(), { type: 'flag_clawback', idx: 1, reason: 'late fee', now: 3200 },
      ),
      'flag mid-round',
    );
    expect(phaseErr.message).toMatch(/cannot flag clawbacks during ladder_vote_closed/);
  });

  it('r12-4: the barrier enforces the write domain, not just equality', () => {
    // The r12-1 hardening, stated as the field's domain: a round number is a
    // non-negative safe integer, and `ladderRound` without a ladder is 0.
    const ladder = threeRoundLadder();
    const domains: ReadonlyArray<readonly [unknown, unknown]> = [
      [0, 0],
      [3, 3],
      [2.5, 2.5],
      [-1, -1],
      [MAX_LADDER_ROUNDS, MAX_LADDER_ROUNDS],
      [HOSTILE, HOSTILE],
    ];
    for (const [value, openRound] of domains) {
      const state = forge(ladder, { ladderRound: value, ladder: { ...ladder.ladder!, round: openRound } });
      const legal = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (legal) {
        expect(() => assertRoundCountersAgree(state), String(value)).not.toThrow();
      } else {
        expect(() => assertRoundCountersAgree(state), String(value)).toThrow(
          CourtConfirmationTransitionError,
        );
      }
    }
    // No ladder: 0 is legal, anything else is a counter with no ledger.
    expect(() => assertRoundCountersAgree(forge(ladder, { ladder: undefined, ladderRound: 0 }))).not.toThrow();
    expect(() => assertRoundCountersAgree(forge(ladder, { ladder: undefined, ladderRound: 1 })))
      .toThrow(/no ladder round is open/);
    // A fractional ladderRound with a numeric ladder.round is refused too (the
    // pre-r12 shape: "2.5 !== 2" was refused, "2.5 === 2.5" was not).
    expect(() => assertRoundCountersAgree(forge(ladder, { ladderRound: 2.5, ladder: { ...ladder.ladder!, round: 2 } })))
      .toThrow(/round counters disagree/);
    // Default ladder length is unaffected by the tightening.
    expect(DEFAULT_LADDER_ROUNDS).toBeLessThanOrEqual(MAX_LADDER_ROUNDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — the r11-5 divergence, decided (r12-5)
// ─────────────────────────────────────────────────────────────────────────────

/** The decimal a host would get from a fixed 15-significant-digit rendering. */
const round15 = (value: number): number => Number(value.toPrecision(15));

describe('T4 (r11-5, deferred) — the decision: CLOSED-BY-DESIGN', () => {
  it('r12-5: the two spellings are two DOUBLES, so no lossless rationalisation can merge them', () => {
    // The deferred fix said: "rationalise from the shortest round-trip decimal of
    // the double, so both spellings produce the same rational". That premise is
    // arithmetically impossible: `String(x)` IS the shortest round-trip decimal
    // (ECMA-262 Number::toString), and two doubles with the same shortest text
    // would parse back to the same double — i.e. they would be the same double.
    const literal = { a_f: 0.5, rho: 0.1, beta: 0.3 };
    const arithmetic = { a_f: 0.5, rho: 0.1, beta: 3 * 0.1 };
    expect(arithmetic.beta).not.toBe(literal.beta);
    expect(Object.is(arithmetic.beta, literal.beta)).toBe(false);
    // Distinct IEEE-754 bit patterns (not a rendering artefact).
    const bits = (value: number): string => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value);
      return view.getBigUint64(0).toString(16);
    };
    expect(bits(arithmetic.beta)).not.toBe(bits(literal.beta));
    // …and the shortest texts differ by exactly the 17th significant digit.
    expect(String(literal.beta)).toBe('0.3');
    expect(String(arithmetic.beta)).toBe('0.30000000000000004');
    // Round-trip: each text names its own double and only its own double.
    expect(Number(String(literal.beta))).toBe(literal.beta);
    expect(Number(String(arithmetic.beta))).toBe(arithmetic.beta);
    // So the field IS canonicalised once (String(double) → one exact rational),
    // and the divergence entered BEFORE the field: the caller computed a
    // different double. The campaign's rule — canonicalise once per field — is
    // satisfied; there is no second spelling of one input left to collapse.
    expect(deriveMaxLadderRounds(literal)).toBe(1);
    expect(deriveMaxLadderRounds(arithmetic)).toBe(2);
    // The code is RIGHT about the value it was given: a bond that is 4e-17
    // larger makes the break-even round strictly unprofitable, so cap 2 is the
    // exact answer for `0.30000000000000004` — and cap 1 is the exact answer for
    // the decimal the policy meant. The defect is the POLICY EXPRESSION, which
    // lives in the host, and the gate follows the same value (one predicate).
    expect(ladderCapWithinBound({ ...literal, maxLadderRounds: 2 }).ok).toBe(false);
    expect(ladderCapWithinBound({ ...arithmetic, maxLadderRounds: 2 }).ok).toBe(true);
    expect(deriveLadderFlipRound(literal)).toBe(2);
    expect(deriveLadderFlipRound(arithmetic)).toBe(3);
  });

  it('r12-5: the only available merge is LOSSY and moves other boundaries — so it is policy, not a fix', () => {
    // A host that wants to collapse the pair must ROUND the parameter (there is
    // no other map). Rounding to 15 significant digits does merge it — and it
    // changes the cap at OTHER parameter points too, which is a new parameter
    // DOMAIN (a policy decision with an owner), not a bug fix disguised as one.
    const arithmeticBeta = 3 * 0.1;
    expect(round15(arithmeticBeta)).toBe(0.3);
    expect(deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: round15(arithmeticBeta) }))
      .toBe(deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: 0.3 }));
    const betas: number[] = [];
    for (const base of [0.3, 0.7, 0.9, 1 / 3, 2 / 3, 0.1, 0.5]) {
      for (const value of [base, base + Number.EPSILON * base, base - Number.EPSILON * base, 3 * 0.1, 0.1 + 0.6]) {
        betas.push(value);
      }
    }
    const moved = new Set<string>();
    for (const a_f of [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
      for (const beta of betas) {
        if (round15(beta) === beta) continue;
        const before = deriveMaxLadderRounds({ a_f, rho: 0.1, beta });
        const after = deriveMaxLadderRounds({ a_f, rho: 0.1, beta: round15(beta) });
        if (before !== after) moved.add(`a_f=${a_f} beta=${String(beta)}: ${before} -> ${after}`);
      }
    }
    // MEASURED: 0.30000000000000004 2→1, 0.7000000000000001 3→2 and
    // 0.10000000000000003 1→0 (all at a_f = ½, where the boundary is an exact
    // integer). Rounding is therefore a parameter-DOMAIN change, not a fix.
    expect(moved.size, `rounding moved: ${[...moved].join('; ')}`).toBeGreaterThanOrEqual(3);
    expect([...moved].some((entry) => entry.includes('beta=0.7000000000000001'))).toBe(true);
    // Which is why the decision is the CALLER's: pass the literal decimal. The
    // deferred trigger stays what round 11 named — a parameter-shape change
    // (decimal text / an exact rational on the wire), which must also revise
    // round 5's `a_f as a string` pin. No such change ships here.
    expect(() => deriveMaxLadderRounds({ a_f: '0.9' as unknown as number, rho: 0.1, beta: 0.3 }))
      .toThrow(/a_f must be a finite accuracy/);
    expect(() => deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: '0.3' as unknown as number }))
      .toThrow(/beta must be a finite positive bond/);
  });

  it('r12-5: the REAL spelling class still agrees — one double, one rational, one cap', () => {
    // The canonicalisation the field does guarantee, kept as the control: every
    // spelling of ONE double is one parameter (round 11's BLOCKED target).
    const spellings = [0.03, 0.030, 3e-2, 0.03e0, 3 / 100];
    for (const beta of spellings) {
      expect(Object.is(beta, 0.03), String(beta)).toBe(true);
      expect(deriveMaxLadderRounds({ a_f: 0.9, rho: 0.03, beta })).toBe(5);
      expect(deriveLadderFlipRound({ a_f: 0.9, rho: 0.03, beta })).toBe(7);
    }
    // 0.3 and 3e-1 are the SAME double (unlike 3 * 0.1): one cap.
    expect(Object.is(3e-1, 0.3)).toBe(true);
    expect(String(3e-1)).toBe('0.3');
    expect(deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: 3e-1 }))
      .toBe(deriveMaxLadderRounds({ a_f: 0.5, rho: 0.1, beta: 0.3 }));
  });
});
