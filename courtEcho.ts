// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * courtEcho — ONE escape for every value this package writes into a refusal.
 *
 * WHY A MODULE (review-round 12). `quoteWireValue` was introduced in round 10
 * for the escalation codec and made TOTAL (over untyped values) in round 11 —
 * but only over the two files the round was looking at
 * (`courtEscalationRequest.ts`, `confirmationMachineCore.ts`). The confirmation
 * reducer's other two files (`confirmationMachineHandlers.ts`,
 * `courtConfirmationMachine.ts`) still interpolated caller- and
 * snapshot-controlled values VERBATIM into ~45 refusals, including
 * `state.phase` — the exact snapshot value round 11 called out — and
 * `String(event.type)` on the front door, which threw a raw `TypeError` for an
 * object type. Round 12's finding is the same shape as round 10's: the escape
 * was measured at the sites that had been attacked rather than at the class.
 *
 * The class is now defined by a MECHANICAL check (`reviewRound12.test.ts` ›
 * the static totality sweep): every template literal used as a typed refusal —
 * or as a state `failure.reason` — must interpolate only a `quote*` call, a
 * module constant, or an expression from a short allowlist of provably safe
 * forms. A future site cannot regress silently: the sweep discovers the files
 * that construct `CourtConfirmationTransitionError` and fails on any new raw
 * interpolation.
 *
 * The escaping rule, stated once: `Cc` (C0/C1 controls — `ESC`, `BEL`, `NUL`,
 * `DEL`, the C1 CSI introducer), `Cf` (bidi overrides, zero-width joiners, soft
 * hyphen, BOM), `Zl`/`Zp` (line/paragraph separators) and `Cs` (lone
 * surrogates) are written as `\u{…}`; nothing is re-interpreted, so the reason
 * and the bytes are both still on the line and neither can BE a line.
 */

/**
 * Characters that may not travel into an error message verbatim (r10-1).
 *
 * Deliberately NOT `/g`: the per-character test below must be stateless
 * (`lastIndex` on a global regex would make the verdict depend on the previous
 * character).
 */
const UNSAFE_ECHO_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * Longest value echoed into a refusal — **the whole output, marker included**.
 *
 * Round 10 documented 64 while clipping the INPUT: a 64-character
 * format-character id escaped to 387 output characters. Round 11 spent the
 * budget on the escaped output but returned `out + '…'`, so the output could be
 * 65 (`docs/REVIEW_ROUND_11.md` §1.3 measured "59" for one id). Round 12
 * measured the last character: the marker is part of the output, so one
 * character of the budget is reserved for it and the bound is exact.
 *
 * The budget is counted in UTF-16 code units (`String#length`), which is never
 * smaller than the code-point count — so an astral character costs two units
 * and the output is bounded in BOTH metrics: at most 64 code units and at most
 * 64 code points.
 */
const MAX_ECHO_CHARS = 64;

/** Budget for the escaped value itself: the marker needs one character. */
const MAX_ECHO_BODY_CHARS = MAX_ECHO_CHARS - 1;

/** One character, escaped if a log line must not carry it verbatim. */
function escapeEchoChar(ch: string): string {
  return UNSAFE_ECHO_CHAR.test(ch)
    ? `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`
    : ch;
}

/**
 * Quote an attacker-supplied wire value for an ERROR MESSAGE (r10-1, r11-1).
 *
 * A refusal is meant to be logged — the append-only escalation log, an
 * operator's stderr, a bug ticket — so a refusal that interpolates the
 * offending value VERBATIM is a log-injection channel: a case id only has its
 * ENDS whitespace-checked, so `"court:A\nESCALATION ACCEPTED for …"` is a legal
 * id and a host that logs the refusal prints a forged, well-formed line after
 * the newline. U+202E (RIGHT-TO-LEFT OVERRIDE) does the same to a rendered line
 * without any newline at all.
 *
 * The value is walked by CODE POINT (`for…of`), so the clip can neither split a
 * surrogate pair into two lone surrogates nor cut an escape in half: the result
 * is always a sequence of complete `\u{…}` escapes, is always a PREFIX of the
 * full escaped value, and carries an explicit `…` when it was clipped — never a
 * string that merely LOOKS complete.
 *
 * NOT INJECTIVE, by design: a value that literally contains `\u{1b}` or `…`
 * renders like an escaped or clipped one. The safe direction is the one that
 * matters (no control character reaches the log); the ambiguity only ever makes
 * a hostile value look more boring than it is.
 */
export function quoteWireValue(value: string): string {
  // TOTAL AT RUNTIME, even though the type says `string` (r12-1): a field the
  // type declares as a string can be `undefined` on a RESTORED record (measured:
  // `bond.bondTxid` after a legacy snapshot drops the column), and a refusal
  // that throws `value is not iterable` is the foreign-error class this module
  // exists to close. A non-string is described like any other untyped value.
  if (typeof (value as unknown) !== 'string') return quoteWireUnknown(value);
  let out = '';
  for (const ch of value) {
    const piece = escapeEchoChar(ch);
    if (out.length + piece.length > MAX_ECHO_BODY_CHARS) return `${out}…`;
    out += piece;
  }
  return out;
}

/**
 * Quote an UNTYPED wire value for a refusal (r11-1): the same escaping, without
 * ever calling `String(value)` on an object.
 *
 * `String({toString(){throw}})` and `String(Object.create(null))` both throw
 * (`Cannot convert object to primitive value`), so a refusal reached through a
 * hostile value object escaped as a raw `TypeError` — the foreign-error-type
 * boundary r3-1/r41-1/r49-d closed — and a `toString` that throws ran caller
 * code inside a refusal. Only primitives are rendered; every object is reported
 * as `<object>` with no user code run.
 */
export function quoteWireUnknown(value: unknown): string {
  if (typeof value === 'string') return quoteWireValue(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return quoteWireValue(String(value));
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return `<${typeof value}>`;
}

/**
 * A ladder round counter for a refusal message (r11-1, r12-1).
 *
 * A restored snapshot can carry ANY value here — that is the state the barriers
 * exist to refuse — so a non-integer is DESCRIBED, never echoed: a string
 * counter would put its newlines into the operator's log, and a `toString` on a
 * restored object runs caller code and can throw.
 */
export function quoteCounter(value: unknown): string {
  // "Integer" here means ROUND NUMBER: the write domain is non-negative, so a
  // negative value is described like a fraction (r12-1 — the barrier now checks
  // the domain, and its message must not imply that `-1` is a legal round).
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : '<not an integer>';
}
