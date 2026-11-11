// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * courtEscalationRequest — the WIRE SHAPE of a challenger's escalation request,
 * and its canonical hash (R43, review-round 7 finding H-6).
 *
 * THE FINDING. The machine has known about the per-round bond witness since R31
 * (`escalate.roundBondProofHash`, `CourtEscalationRecord.roundBondProofHash`),
 * and R42 made the strict policy (`requireRoundBond: true`) the DEFAULT for new
 * cases. But the thing the host actually transports carries none of it: the
 * escalation body is an `additionalProperties: false` object without a
 * round-bond field, and the request hash preimage omits it too. So a strict
 * case's challenger cannot submit the witness the reducer demands, every
 * escalation on a strict case is refused, and — because the hash ignores the
 * field — two DIFFERENT round bonds would hash to ONE request hash if a host
 * ever did pass one through. Transport must ship BEFORE enforcement; this module
 * is the package-side half of that order of operations (the host half wires the
 * HTTP body and the request hash to it).
 *
 * WHAT THIS MODULE IS. One versioned, canonical codec for the request —
 * `build` (validate + normalise), `serialize`/`parse` (JSON round-trip, strict
 * about unknown fields), `hash` (the canonical preimage, v2, which now binds the
 * round-bond witness), and `toMachineEvent` (the exact `escalate` event the
 * reducer expects, field by field — including the membership bond AND the
 * per-round bond).
 *
 * FIELD-BY-FIELD AGAINST THE REDUCER. `CourtConfirmationMachineEvent`'s
 * `escalate` arm expects `authority`, `challengerIdx`, `challengerPubkey`,
 * `requestHash`, `bondProofHash`, optional `roundBondProofHash`, `roundIndex`
 * and `now`. A request carries the challenger's half (`challengerPubkey`,
 * `bondProofHash`, `roundBondProofHash`, the signed `eventId`/`signedAtSec`);
 * the HOST's half (`challengerIdx`, `roundIndex`, `now`) comes from the case
 * state, never from the wire — a challenger cannot choose its own roster index
 * or the round it opens. {@link escalationRequestToMachineEvent} performs that
 * split and fails closed when the case has no accepted challenge carrying the
 * request's membership bond.
 *
 * DOMAIN v2. R43 inserts the round-bond witness into the preimage and bumps the
 * domain string, because a v1 hash that ignores a field cannot be "fixed" by
 * adding it — the old digest would still verify for a request with a different
 * witness. The host carries a byte-identical implementation in
 * `CourtEscalationService.ts` (`ESCALATION_REQUEST_DOMAIN`), and both suites pin
 * the same known-answer digest so the two cannot drift.
 *
 * REVIEW ROUND 8 — what the round-7 codec did NOT do. The original shape had
 * three defects, all fixed here and pinned in `__tests__/reviewRound8.test.ts`:
 *
 *  - **`caseId` was encoded lossily (r8-1).** `TextEncoder` maps an unpaired
 *    UTF-16 surrogate to U+FFFD, so `"…:1\uD800"` and `"…:1\uFFFD"` — two
 *    DIFFERENT case ids, two different wire strings — produced the SAME
 *    preimage bytes and therefore the SAME request hash: the r7 H-6 collision
 *    (one digest, two requests) one field over. `caseId` is now canonical UTF-8,
 *    NUL-free and byte-bounded, which makes the encoding injective.
 *  - **`parse` accepted DUPLICATE keys (r8-4).** `JSON.parse` silently keeps the
 *    last of two `"roundBondProofHash"` slots, so one digest covered many byte
 *    strings — an audit reading the raw body saw a witness the machine never
 *    saw. The raw text is now scanned at depth 1 and a repeated field is a
 *    refusal. A repeated `concession` (or any non-boolean) is refused too: a
 *    silently coerced `"true"` → `false` flips a signed field (r8-3).
 *  - **The mapping bound NOTHING (r8-2).** `escalationRequestToMachineEvent`
 *    minted a reducer event from three wire claims that neither it nor the
 *    reducer can check — `challengerPubkey` (it filled `challengerIdx` from the
 *    bond owner but never compared the two, so the append-only escalation log
 *    could name a juror who never escalated), `caseId` (never compared against
 *    the case), and `round` (ignored: a request signed for round 1 opened round
 *    3, because `roundIndex` is derived from the case). The mapping now REQUIRES
 *    the host's binding — the case id it routed on and the pubkey NIP-98
 *    authenticated — and refuses a request that disagrees with either.
 *
 * REVIEW ROUND 9 — what round 8's fixes did NOT do. Each is pinned in
 * `__tests__/reviewRound9.test.ts` and recorded in `docs/REVIEW_ROUND_9.md`:
 *
 *  - **`caseId` was still FOLDED (r9-1).** r8-1 validated `value.trim()` and
 *    returned it, so `"court:X "`, `"court:X\t"` and `"court:X\u{3000}"` were
 *    one id with ONE digest — the same defect, and `build` returning an id the
 *    caller never supplied (the r8-5 shape). The host binding compared
 *    `expectedCaseId.trim()`, so the fold was symmetric and a request could
 *    cross the whitespace class. Ids are now validated EXACTLY (refused if they
 *    carry surrounding whitespace), and the preimage no longer trims.
 *  - **`bondTxid` was unbound (r9-2).** The bond filter matches `bondProofHash`,
 *    and `bondTxid` went into the preimage uncompared with the challenge
 *    record, so the logged `requestHash` could commit to a bond the case never
 *    bound. It must now equal `CourtChallengeRecord.bondTxid`.
 *  - **A CONCESSION was minted as an ESCALATION (r9-3).** `concession: true`
 *    commits `'1'` to the hash and was then ignored, so an escalate event could
 *    be minted from a request whose signer dropped the appeal — the log records
 *    an authorisation he refused. Now a typed refusal; route it to `concede`.
 *  - **The r8-2 binding is a TRUST ANCHOR, not a proof (r9-6).** A host that
 *    fills `authenticatedPubkey` from the wire's `challengerPubkey` reproduces
 *    the pre-r8-2 harm exactly, and no pure function can tell "verified" from
 *    "copied". Registered boundary, pinned as a test, obligation stated on
 *    {@link CourtEscalationBinding}: the value must come from the auth layer.
 *
 * Purity: pure functions; no I/O, no clock, no randomness.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent } from 'nostr-tools/pure';

import { HEX_32, isRecord } from './courtEventParseCore';
import { isCanonicalUtf8Text } from './courtCeremonyCore';
import type {
  CourtConfirmationMachineEvent,
  CourtConfirmationMachineState,
} from './confirmationMachineTypes';
import { CourtConfirmationTransitionError } from './courtConfirmationMachine';

/** Domain string for the canonical request hash. v2 = binds the round bond. */
export const COURT_ESCALATION_REQUEST_DOMAIN = 'BAO-Court/Escalation/Request/v2';

/** Wire version of the request payload (independent of the hash domain). */
export const COURT_ESCALATION_REQUEST_VERSION = 2;

/** Highest ladder round a request may name (mirrors the machine ceiling). */
export const MAX_ESCALATION_REQUEST_ROUND = 5;

/**
 * Byte bound on `caseId` (r8-1). A case id is a routing key a host stores and
 * logs; it has no length semantics, so a megabyte of it only prices hashing and
 * log lines. 256 bytes is far above any real id.
 */
export const MAX_ESCALATION_CASE_ID_BYTES = 256;

/**
 * The challenger's escalation request, as transported.
 *
 * `round` is the RESOLVED round the challenger wants to escalate past (the
 * request opens `round + 1`); `bondProofHash` is the case's membership bond
 * witness; `roundBondProofHash` is the per-round payment for the round being
 * opened — `null` only on a legacy (`requireRoundBond: false`) case, and a
 * strict case refuses the resulting event.
 */
export interface CourtEscalationRequest {
  readonly caseId: string;
  readonly round: number;
  /** x-only 32-byte hex pubkey of the requesting challenger (NIP-98 authed). */
  readonly challengerPubkey: string;
  /** hex32 txid of the bond the request is made under. */
  readonly bondTxid: string;
  /** hex32 membership bond witness (the case's accepted challenge bond). */
  readonly bondProofHash: string;
  /** hex32 per-round bond witness, or null on a legacy request (R31). */
  readonly roundBondProofHash: string | null;
  /** hex32 id of the published request event. */
  readonly eventId: string;
  /** Client signature time (unix seconds) — replay bound, never a clock. */
  readonly signedAtSec: number;
  /** True when the challenger DROPS the appeal (concede, never blocked). */
  readonly concession: boolean;
}

/** The exact set of wire fields — unknown fields are a parse error. */
const WIRE_FIELDS = [
  'caseId',
  'round',
  'challengerPubkey',
  'bondTxid',
  'bondProofHash',
  'roundBondProofHash',
  'eventId',
  'signedAtSec',
  'concession',
] as const;

const textEncoder = new TextEncoder();

/**
 * Characters that may not travel into an error message verbatim (r10-1).
 *
 * `Cc` = C0/C1 controls (newline, tab, NEL U+0085, …), `Cf` = format characters
 * (zero-width space/joiners, bidi marks and overrides U+200B–U+200F,
 * U+202A–U+202E, U+2066–U+2069, soft hyphen, U+180E, BOM), `Zl`/`Zp` = the line
 * and paragraph separators, `Cs` = lone surrogates.
 */
const UNSAFE_ECHO = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/** Longest value echoed into a refusal (chars), so one refusal cannot flood a log. */
const MAX_ECHO_CHARS = 64;

/**
 * Quote an attacker-supplied wire value for an ERROR MESSAGE (r10-1).
 *
 * Every refusal in this module is meant to be logged — the append-only
 * escalation log, an operator's stderr, a bug ticket — so a refusal that
 * interpolates the offending value VERBATIM is a log-injection channel. A case
 * id may carry any character that survives the id rules: only the ENDS are
 * whitespace-checked, so `"court:A\nESCALATION ACCEPTED for …"` is a legal id,
 * and a host that logs the refusal prints a forged, well-formed line after the
 * newline. U+202E (RIGHT-TO-LEFT OVERRIDE) does the same to a rendered line
 * without any newline at all, and a 256-byte id doubled into a two-id message
 * makes every refusal a 512-byte log entry.
 *
 * Escaping the value (never re-interpreting it) is the fix that keeps the
 * diagnostic: the reason and the bytes are both still on the line, they just
 * cannot BE a line.
 */
function quoteWireValue(value: string): string {
  const chars = [...value];
  const clipped = chars.length <= MAX_ECHO_CHARS
    ? value
    : `${chars.slice(0, MAX_ECHO_CHARS).join('')}…`;
  return clipped.replace(
    UNSAFE_ECHO,
    (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

function assertHex32(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtConfirmationTransitionError(
      `escalation request ${field} must be 32-byte lowercase hex`,
    );
  }
  return value;
}

/**
 * Validate a case id (r8-1, r9-1).
 *
 * The id is a FIELD OF THE HASH PREIMAGE, so it must encode injectively: an
 * unpaired surrogate would be replaced by U+FFFD on the way into `TextEncoder`,
 * collapsing two distinct ids into one digest. The preimage also separates
 * fields with U+0000, so a NUL inside the id would blur a field boundary (a
 * fixed field count keeps that from colliding today, but the codec must not
 * depend on counting to stay sound). Canonical UTF-8, no NUL, bounded bytes.
 *
 * VALIDATE, DO NOT NORMALISE (r9-1). The r8-1 version returned `value.trim()`,
 * which is a lossy map: `"court:X "`, `"court:X\t"` and `"court:X\u{3000}"` all
 * became `"court:X"` and therefore all shared ONE digest — the same
 * two-ids-one-digest defect r8-1 was written to close, plus the r8-5 shape
 * (`build` returning an id the caller never supplied). It also made the host's
 * binding fold, so a request for case `"court:X"` routed against a case stored
 * as `"court:X "` was accepted: the "a request must not cross cases" claim was
 * true only up to the whitespace class. Ids a host GENERATES never carry
 * surrounding whitespace, so the fail-closed direction is free: refuse, and the
 * accepted domain is exactly the set of strings that encode injectively.
 *
 * NO UNICODE NORMALISATION, deliberately (r9-1). `"café"` (NFC) and
 * `"cafe\u0301"` (NFD) are two distinct ids with two distinct digests even
 * though they RENDER identically. Normalising would create the collision
 * (`NFC(a) === NFC(b)` for different `a`, `b`); the residual is an audit/display
 * confusable, which the host resolves by rendering ids escaped or by generating
 * ASCII ids. Pinned in `__tests__/reviewRound9.test.ts`.
 */
function normalizeCaseId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new CourtConfirmationTransitionError(`${label} must be a non-empty string`);
  }
  // Checked on the RAW value: a fold must never mask a non-canonical string.
  if (!isCanonicalUtf8Text(value)) {
    throw new CourtConfirmationTransitionError(
      `${label} must be canonical UTF-8 (no unpaired surrogates)`,
    );
  }
  if (value.includes('\u0000')) {
    throw new CourtConfirmationTransitionError(`${label} must not contain U+0000`);
  }
  if (value.trim() === '') {
    throw new CourtConfirmationTransitionError(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new CourtConfirmationTransitionError(
      `${label} must not have leading or trailing whitespace: folding it would give two different `
      + 'ids one request hash (r9-1)',
    );
  }
  if (textEncoder.encode(value).length > MAX_ESCALATION_CASE_ID_BYTES) {
    throw new CourtConfirmationTransitionError(
      `${label} exceeds ${MAX_ESCALATION_CASE_ID_BYTES} bytes`,
    );
  }
  return value;
}

/**
 * Validate and normalise a request. The ONLY constructor the wire needs.
 *
 * `roundBondProofHash` may be omitted (normalised to `null`); `concession`
 * defaults to `false`. Everything else is required and shape-checked, so a
 * caller cannot build a request the host would have to guess about.
 *
 * Every input field is read EXACTLY ONCE into a local (r8-5): a getter or
 * `Proxy` used to be able to hand the emptiness check one `caseId` and the
 * returned request another — validation of A, use of B — and to escape as a raw
 * `TypeError` (`input.caseId.trim is not a function`) instead of this module's
 * typed refusal. Snapshot first, then validate the snapshot.
 *
 * @throws {@link CourtConfirmationTransitionError} on any malformed field.
 */
export function buildCourtEscalationRequest(input: {
  readonly caseId: string;
  readonly round: number;
  readonly challengerPubkey: string;
  readonly bondTxid: string;
  readonly bondProofHash: string;
  readonly roundBondProofHash?: string | null;
  readonly eventId: string;
  readonly signedAtSec: number;
  readonly concession?: boolean;
}): CourtEscalationRequest {
  const caseIdRaw: unknown = input.caseId;
  const roundRaw: unknown = input.round;
  const challengerPubkeyRaw: unknown = input.challengerPubkey;
  const bondTxidRaw: unknown = input.bondTxid;
  const bondProofHashRaw: unknown = input.bondProofHash;
  const roundBondProofHashRaw: unknown = input.roundBondProofHash;
  const eventIdRaw: unknown = input.eventId;
  const signedAtSecRaw: unknown = input.signedAtSec;
  const concessionRaw: unknown = input.concession;

  const caseId = normalizeCaseId(caseIdRaw, 'escalation request caseId');
  if (
    !Number.isSafeInteger(roundRaw)
    || (roundRaw as number) < 1
    || (roundRaw as number) > MAX_ESCALATION_REQUEST_ROUND
  ) {
    throw new CourtConfirmationTransitionError(
      `escalation request round must be an integer in 1..${MAX_ESCALATION_REQUEST_ROUND} `
      + `(got ${quoteWireValue(String(roundRaw))})`,
    );
  }
  const roundBondProofHash = roundBondProofHashRaw == null
    ? null
    : assertHex32(roundBondProofHashRaw, 'round_bond_proof_hash');
  if (!Number.isSafeInteger(signedAtSecRaw) || (signedAtSecRaw as number) < 0) {
    throw new CourtConfirmationTransitionError(
      'escalation request signedAtSec must be a non-negative safe integer',
    );
  }
  // r8-3: a signed flag is not a truthiness test. `"true"`, `1`, `{}` and `null`
  // all used to parse as `false` — a dropped concession, and a field that means
  // one thing to a permissive peer and another here.
  if (concessionRaw !== undefined && typeof concessionRaw !== 'boolean') {
    throw new CourtConfirmationTransitionError(
      'escalation request concession must be a boolean (or absent, meaning false)',
    );
  }
  return {
    caseId,
    round: roundRaw as number,
    challengerPubkey: assertHex32(challengerPubkeyRaw, 'challenger_pubkey'),
    bondTxid: assertHex32(bondTxidRaw, 'bond_txid'),
    bondProofHash: assertHex32(bondProofHashRaw, 'bond_proof_hash'),
    roundBondProofHash,
    eventId: assertHex32(eventIdRaw, 'event_id'),
    signedAtSec: signedAtSecRaw as number,
    concession: concessionRaw === true,
  };
}

/**
 * The canonical preimage: `domain ‖ 0x00 ‖ caseId ‖ round ‖ challengerPubkey ‖
 * bondTxid ‖ bondProofHash ‖ roundBondProofHash ‖ eventId ‖ signedAtSec ‖
 * concession`, fields joined by `\u0000`.
 *
 * The case id is used EXACTLY as validated (r9-1): a `trim()` here would
 * re-introduce the fold `buildCourtEscalationRequest` refuses, for any caller
 * that hand-builds a request object and calls this function directly.
 *
 * The round-bond slot is `'-'` when the request carries none — a sentinel no
 * hex32 value can equal, so "absent" and "present" can never hash the same.
 */
export function courtEscalationRequestPreimage(request: CourtEscalationRequest): string {
  return [
    request.caseId,
    String(request.round),
    request.challengerPubkey,
    request.bondTxid,
    request.bondProofHash,
    request.roundBondProofHash ?? '-',
    request.eventId,
    String(request.signedAtSec),
    request.concession ? '1' : '0',
  ].join('\u0000');
}

/**
 * Canonical hex32 hash of a request (v2): every field the host verified,
 * INCLUDING the per-round bond witness. Two requests that differ only in their
 * round bond therefore have different hashes — the r7 H-6 collision.
 *
 * @throws {@link CourtConfirmationTransitionError} on a malformed request
 *         (re-validated, so a hand-built object cannot bypass the codec).
 */
export function hashCourtEscalationRequest(request: CourtEscalationRequest): string {
  const normalised = buildCourtEscalationRequest(request);
  const domain = textEncoder.encode(COURT_ESCALATION_REQUEST_DOMAIN);
  const body = textEncoder.encode(courtEscalationRequestPreimage(normalised));
  const input = new Uint8Array(domain.length + 1 + body.length);
  input.set(domain, 0);
  input[domain.length] = 0x00;
  input.set(body, domain.length + 1);
  return bytesToHex(sha256(input));
}

/**
 * Serialise a request to the canonical JSON wire form (declared field order,
 * `roundBondProofHash` always present so a reader can tell "absent" from
 * "omitted by a buggy peer").
 */
export function serializeCourtEscalationRequest(request: CourtEscalationRequest): string {
  const normalised = buildCourtEscalationRequest(request);
  const wire: Record<(typeof WIRE_FIELDS)[number], unknown> = {
    caseId: normalised.caseId,
    round: normalised.round,
    challengerPubkey: normalised.challengerPubkey,
    bondTxid: normalised.bondTxid,
    bondProofHash: normalised.bondProofHash,
    roundBondProofHash: normalised.roundBondProofHash,
    eventId: normalised.eventId,
    signedAtSec: normalised.signedAtSec,
    concession: normalised.concession,
  };
  return JSON.stringify(wire);
}

/**
 * Decode the JSON string starting at `start` (which points at the opening
 * quote). Returns the decoded value and the index just past the closing quote.
 * Used by the duplicate-key scan; the text has already passed `JSON.parse`, so
 * an escape here cannot be malformed.
 */
function decodeJsonStringAt(text: string, start: number): { value: string; end: number } {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '"') {
      const raw = text.slice(start, index + 1);
      try {
        return { value: JSON.parse(raw) as string, end: index + 1 };
      } catch {
        throw new CourtConfirmationTransitionError('escalation request is not valid JSON');
      }
    }
    index += 1;
  }
  throw new CourtConfirmationTransitionError('escalation request is not valid JSON');
}

/** Index just past the JSON value starting at `start`. */
function skipJsonValue(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  const ch = text[index];
  if (ch === '"') return decodeJsonStringAt(text, index).end;
  if (ch === '{' || ch === '[') {
    let depth = 0;
    while (index < text.length) {
      const current = text[index];
      if (current === '"') {
        index = decodeJsonStringAt(text, index).end;
        continue;
      }
      if (current === '{' || current === '[') depth += 1;
      else if (current === '}' || current === ']') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    throw new CourtConfirmationTransitionError('escalation request is not valid JSON');
  }
  while (index < text.length && !/[,}\]\s]/.test(text[index])) index += 1;
  return index;
}

/**
 * Refuse a top-level object that repeats a field name (r8-4).
 *
 * `JSON.parse` resolves duplicates silently (last one wins), so
 * `{"roundBondProofHash":null,"roundBondProofHash":"<real>"}` is ONE request to
 * this codec and TWO claims to anyone reading the raw body — the same
 * one-digest-many-requests shape as the r7 H-6 collision, and precisely what an
 * `additionalProperties: false` wire contract is supposed to exclude. Keys are
 * compared after decoding, so `"caseId"` and `"c\u0061seId"` are one field.
 *
 * Only the STRING form can be checked: an already-parsed object has lost the
 * duplicate. Hosts that must accept objects should hand this module the body
 * text, not their own `JSON.parse` output.
 */
function assertNoRepeatedWireFields(text: string): void {
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  skipWhitespace();
  if (text[index] !== '{') return; // the object-shape check reports this
  index += 1;
  const seen = new Set<string>();
  for (;;) {
    skipWhitespace();
    if (text[index] === '}') return;
    const key = decodeJsonStringAt(text, index);
    index = key.end;
    skipWhitespace();
    if (text[index] !== ':') {
      throw new CourtConfirmationTransitionError('escalation request is not valid JSON');
    }
    index += 1;
    if (seen.has(key.value)) {
      throw new CourtConfirmationTransitionError(
        `escalation request repeats the field ${quoteWireValue(key.value)}`,
      );
    }
    seen.add(key.value);
    index = skipJsonValue(text, index);
    skipWhitespace();
    if (text[index] === ',') {
      index += 1;
      continue;
    }
    if (text[index] === '}') return;
    throw new CourtConfirmationTransitionError('escalation request is not valid JSON');
  }
}

/**
 * Parse the canonical wire form, fail-closed.
 *
 * Accepts a JSON string or an already-parsed object. Unknown fields are a
 * REFUSAL (not ignored): `additionalProperties: false` is the point of a wire
 * shape, and a peer that silently drops a field is how H-6 happened. A repeated
 * field is a refusal too (r8-4), and a non-boolean `concession` is a refusal
 * rather than a coerced `false` (r8-3). A missing `roundBondProofHash` is
 * normalised to `null` (the legacy shape); a missing `concession` to `false`.
 *
 * @throws {@link CourtConfirmationTransitionError} on anything else.
 */
export function parseCourtEscalationRequest(raw: unknown): CourtEscalationRequest {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new CourtConfirmationTransitionError('escalation request is not valid JSON');
    }
    assertNoRepeatedWireFields(raw);
  }
  if (!isRecord(value)) {
    throw new CourtConfirmationTransitionError('escalation request must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!(WIRE_FIELDS as readonly string[]).includes(key)) {
      throw new CourtConfirmationTransitionError(
        `escalation request has an unknown field ${quoteWireValue(key)}`,
      );
    }
  }
  return buildCourtEscalationRequest({
    caseId: value.caseId as string,
    round: value.round as number,
    challengerPubkey: value.challengerPubkey as string,
    bondTxid: value.bondTxid as string,
    bondProofHash: value.bondProofHash as string,
    roundBondProofHash: (value.roundBondProofHash ?? null) as string | null,
    eventId: value.eventId as string,
    signedAtSec: value.signedAtSec as number,
    concession: value.concession as boolean | undefined,
  });
}

/**
 * What the HOST knows and the wire cannot prove, supplied to
 * {@link escalationRequestToMachineEvent} so the transport can bind the three
 * claims the reducer has no roster to check (r8-2).
 *
 * `caseId` is the case id the host resolved the request against (its routing
 * key); `authenticatedPubkey` is the x-only pubkey the request's authentication
 * (NIP-98) actually proved — never a value taken from the body.
 *
 * THIS IS A TRUST ANCHOR, NOT A PROOF (r9-6). The mapper can only compare the
 * binding with the request; it cannot tell a value the host VERIFIED from the
 * same value COPIED out of the request. A host that passes
 * `{ caseId: request.caseId, authenticatedPubkey: request.challengerPubkey }`
 * reproduces the pre-r8-2 harm exactly — a bonded challenger's escalation whose
 * append-only log names a juror who never escalated, because `challengerIdx`
 * comes from the bond record and the pubkey from the wire. The protection is
 * therefore a host obligation with a named owner: `authenticatedPubkey` must be
 * the value the auth layer derived from the signed request (NIP-98 event pubkey
 * / bearer-session identity), and `caseId` must be the id of the case the host
 * looked up — never an echo of the body. Pinned as a visible boundary in
 * `__tests__/reviewRound9.test.ts` › `T2 (r9-6)`, so the residual is a decision
 * on the record rather than an assumption.
 *
 * What the binding does NOT close: bond OWNERSHIP (r40-3). The state carries no
 * idx→pubkey registry (r29-5/r38-3), so the mapper cannot tell the juror who
 * paid a bond from a juror who registered its publicly derivable witness first;
 * the host's bond verifier must bind the witness to the event author.
 */
export interface CourtEscalationBinding {
  readonly caseId: string;
  readonly authenticatedPubkey: string;
}

/**
 * The published request EVENT, as its signature sees it (r10-3).
 *
 * Only the seven fields a Nostr id commits to: `id = sha256(canonical
 * [0, pubkey, created_at, kind, tags, content])`, and the signature covers
 * `id`. That is why this — not the request body — is the authority: the body is
 * a set of fields a caller can retype, while `content` is bytes the signer
 * signed.
 */
export interface CourtEscalationRequestEvent {
  readonly kind: number;
  readonly pubkey: string;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly id: string;
  readonly sig: string;
}

/**
 * The bytes a request is SIGNED over (r10-3): the canonical wire form WITHOUT
 * `eventId`.
 *
 * The field is the id of the very event that carries these bytes, so it cannot
 * be inside them — a hash cannot contain its own digest. Publishing
 * `content: courtEscalationRequestSignedContent(request)` and then setting
 * `eventId` to the resulting event id is the only non-circular shape, which is
 * why the builder ships with the verifier: a host that invents its own content
 * layout is outside the binding below.
 */
export function courtEscalationRequestSignedContent(request: CourtEscalationRequest): string {
  const normalised = buildCourtEscalationRequest(request);
  const wire = JSON.parse(serializeCourtEscalationRequest(normalised)) as Record<string, unknown>;
  delete wire.eventId;
  return JSON.stringify(wire);
}

/**
 * Derive the host binding from the SIGNED request event (r10-3), instead of
 * accepting two strings the host might have copied out of the body (r9-6).
 *
 * WHY THIS EXISTS. r9-3 refused a request whose `concession` flag was `true`, so
 * the mapper could not mint an ESCALATION from the body of a signed CONCESSION.
 * That guard is a FIELD check, and the flag is a field: the same signed event
 * re-presented with `concession: false` was accepted (measured — `docs/
 * REVIEW_ROUND_10.md` §3), minting an escalation whose `requestHash` was the
 * hash of a request nobody signed (`H(concession=0)` for bytes that said `1`).
 * The mirror direction is worse and has no guard at all: the package offers no
 * concession transition, so nothing refused a signed ESCALATION re-labelled
 * `concession: true` — and it is the flag, not the signature, that a host reads
 * to decide whether the appeal is dropped.
 *
 * WHAT BINDS IT. `content` must equal {@link courtEscalationRequestSignedContent}
 * of THE request being verified (the canonical wire form minus `eventId`, which
 * is the event's own id and therefore cannot be inside it), and the id and
 * signature must cover that content. The flag, the case id, the round, both bond
 * witnesses and `signedAtSec` are all inside those bytes, so:
 *
 *  - a SIGNED concession cannot become an escalation and a SIGNED escalation
 *    cannot become a concession — flipping the flag changes `content`, so the
 *    event id no longer names this request (both directions pinned);
 *  - a request cannot be replayed under another KIND, because `kind` is inside
 *    the id (`expectedKind` is the host's request kind, checked here);
 *  - `caseId` needs no host binding at all: it is signed;
 *  - `authenticatedPubkey` is the event's author, derived from the signature —
 *    never an echo of the body (this is what r9-6 registered as impossible for a
 *    pure string comparison).
 *
 * A host that publishes requests with `serializeCourtEscalationRequest(request)`
 * as `content` can therefore close r9-6 and r10-3 in one call: pass the result
 * to {@link escalationRequestToMachineEvent}. A host that keeps its own event
 * shape must do the same two comparisons itself.
 *
 * @throws {@link CourtConfirmationTransitionError} when the event is not of
 *         `expectedKind`, does not carry this request's id, fails signature
 *         verification, was authored by a key other than the claimed
 *         challenger, was created at another time, or carries content that is
 *         not this request's canonical serialization.
 */
export function escalationRequestBindingFromSignedEvent(
  request: CourtEscalationRequest,
  event: CourtEscalationRequestEvent,
  expectedKind: number,
): CourtEscalationBinding {
  const normalised = buildCourtEscalationRequest(request);
  if (!isRecord(event)) {
    throw new CourtConfirmationTransitionError(
      'escalation request event must be an object',
    );
  }
  if (!Number.isSafeInteger(expectedKind) || expectedKind < 0 || event.kind !== expectedKind) {
    throw new CourtConfirmationTransitionError(
      `escalation request event has kind ${String(event.kind)} but this route publishes kind `
      + `${String(expectedKind)}: a request signed for another kind is another claim (r10-3)`,
    );
  }
  if (event.id !== normalised.eventId) {
    throw new CourtConfirmationTransitionError(
      'escalation request names an event id that is not the id of the signed event presented with it',
    );
  }
  // Rebuilt as a plain object before verification: nostr-tools memoises the
  // verdict ON the object it is handed (see `validator.ts`), so a caller's
  // object that already carries a verdict must not be reused as the input.
  const plain = {
    kind: event.kind,
    pubkey: event.pubkey,
    created_at: event.created_at,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    id: event.id,
    sig: event.sig,
  };
  if (!verifyEvent(plain as Parameters<typeof verifyEvent>[0])) {
    throw new CourtConfirmationTransitionError(
      'escalation request event signature does not verify: the request is not what its author signed',
    );
  }
  if (plain.pubkey !== normalised.challengerPubkey) {
    throw new CourtConfirmationTransitionError(
      'escalation request challengerPubkey is not the author of the signed event: the wire claim has '
      + 'no signature over it',
    );
  }
  if (plain.created_at !== normalised.signedAtSec) {
    throw new CourtConfirmationTransitionError(
      'escalation request signedAtSec is not the created_at of the signed event',
    );
  }
  if (plain.content !== courtEscalationRequestSignedContent(normalised)) {
    throw new CourtConfirmationTransitionError(
      'escalation request is not the canonical serialization the signed event carries: a field of the '
      + 'body (the concession flag, the case id, a bond witness, the round) differs from what was '
      + 'signed, so the digest of this request is a claim nobody authorised (r10-3)',
    );
  }
  return { caseId: normalised.caseId, authenticatedPubkey: plain.pubkey };
}

/**
 * Build the reducer's `escalate` event from a transported request.
 *
 * The split is deliberate: the wire supplies the challenger's claims; the CASE
 * supplies everything the challenger must not choose — the roster index that
 * owns the membership bond (`challengerIdx`), the round being opened
 * (`ladderRound + 1`), and the host clock (`now`). Every field of the reducer's
 * event is filled, so a host cannot drop the round bond on the way in.
 *
 * WHAT THE BINDING IS FOR (r8-2). Filling `challengerIdx` from the bond owner
 * makes it look as though the wire's `challengerPubkey` was verified against the
 * roster; it was not. `CourtConfirmationMachineState` carries indices, not
 * pubkeys, so the reducer cannot pair them (r29-5) and this mapper did not
 * either — a bonded challenger could mint an escalation whose append-only log
 * names ANY juror's pubkey, which is the r29-2 attribution harm (fees, bans)
 * reintroduced at mint time. The wire's `caseId` was likewise never compared
 * with the case, and its `round` was ignored altogether: a request signed to
 * escalate past round 1 was accepted at round 3 (`roundIndex` comes from the
 * case), so one signed request could open a rung its signer never authorised —
 * replayable on every round of a legacy case, where the witness is `null` and
 * nothing is consumed. The three claims are therefore checked against the host's
 * binding here, and a missing binding is a refusal: an unbound escalation is
 * exactly what this function used to mint.
 *
 * @throws {@link CourtConfirmationTransitionError} when the binding is absent or
 *         disagrees with the request, when the request names a round the case is
 *         not resolving, when it is a CONCESSION rather than an escalation
 *         (r9-3), when its `bondTxid` is not the txid of the challenge record its
 *         witness selects (r9-2), or when the case has no single accepted
 *         challenge carrying the request's membership bond.
 */
export function escalationRequestToMachineEvent(
  state: CourtConfirmationMachineState,
  request: CourtEscalationRequest,
  now: number,
  binding?: CourtEscalationBinding,
): Extract<CourtConfirmationMachineEvent, { type: 'escalate' }> {
  const normalised = buildCourtEscalationRequest(request);
  // r9-3: a CONCESSION is not an escalation. The flag is part of the preimage
  // (`'1'` vs `'0'`, so the digests differ), which means an escalate event
  // minted from a concession request records an authorisation its signer
  // explicitly refused: the append-only log would claim "this challenger
  // escalated" against a request that says "this challenger drops the appeal",
  // and the case climbs a rung (a fresh round bond, a summoned panel) instead of
  // finalizing. The challenger's exits are not the host's to convert, so the
  // conversion is a typed refusal — route a concession to `concede`.
  if (normalised.concession) {
    throw new CourtConfirmationTransitionError(
      'escalation request is a CONCESSION (concession = true): it authorises dropping the appeal, not '
      + 'opening a rung — route it to the `concede` transition; minting an escalate event from it '
      + 'records an authorisation the challenger refused (r9-3)',
    );
  }
  if (binding === undefined || binding === null || typeof binding !== 'object') {
    throw new CourtConfirmationTransitionError(
      'escalation request binding is required: pass { caseId, authenticatedPubkey } — the transport '
      + 'will not mint an escalation from wire claims nothing has verified (r8-2)',
    );
  }
  const expectedCaseId: unknown = binding.caseId;
  const authenticatedPubkey: unknown = binding.authenticatedPubkey;
  const boundCaseId = normalizeCaseId(expectedCaseId, 'escalation request binding caseId');
  if (typeof authenticatedPubkey !== 'string' || !HEX_32.test(authenticatedPubkey)) {
    throw new CourtConfirmationTransitionError(
      'escalation request binding authenticatedPubkey must be the 32-byte lowercase hex key the '
      + 'request authenticated as',
    );
  }
  if (normalised.caseId !== boundCaseId) {
    throw new CourtConfirmationTransitionError(
      `escalation request names case "${quoteWireValue(normalised.caseId)}" but the host bound it to `
      + `"${quoteWireValue(boundCaseId)}" — a request must not cross cases`,
    );
  }
  if (normalised.challengerPubkey !== authenticatedPubkey) {
    throw new CourtConfirmationTransitionError(
      'escalation request challengerPubkey is not the pubkey the request authenticated as: the wire '
      + 'claim is unverified, so an escalation may not be attributed to it',
    );
  }
  if (normalised.round !== state.ladderRound) {
    throw new CourtConfirmationTransitionError(
      `escalation request was signed to escalate past round ${normalised.round} but the case is `
      + `resolving round ${state.ladderRound} — a stale request must not open a rung its signer never `
      + 'authorised',
    );
  }
  // r9-4, the transport half: `round === ladderRound` is only meaningful if the
  // case has ONE round number. The machine writes `ladderRound` and
  // `ladder.round` together, so a snapshot where they disagree is not a state it
  // could have produced — and the reducer's history rule sizes itself from
  // `ladder.round` while every escalation rule uses `ladderRound`, so minting an
  // attribution record for such a state picks a round number by side effect.
  if (!isRecord(state.ladder)) {
    throw new CourtConfirmationTransitionError(
      'escalation request landed on a case with no open ladder round: there is nothing to escalate '
      + `past (phase ${String(state.phase)})`,
    );
  }
  if (state.ladder.round !== state.ladderRound) {
    throw new CourtConfirmationTransitionError(
      `the round counters disagree: ladderRound is ${state.ladderRound} but the open round is `
      + `${state.ladder.round} — an escalation must not be minted against a snapshot the machine `
      + 'could not have produced (r9-4)',
    );
  }
  const bonds = state.challenges.filter((c) => c.bondProofHash === normalised.bondProofHash);
  if (bonds.length === 0) {
    throw new CourtConfirmationTransitionError(
      'no accepted challenge bond to bind an escalation witness to',
    );
  }
  // One bond, one owner (r38-1) is a ledger invariant the reducer re-checks; the
  // mapper must not silently pick the first of two owners on a restored snapshot.
  if (bonds.length > 1) {
    throw new CourtConfirmationTransitionError(
      `the case binds one bond proof hash to ${bonds.length} accepted challenges: the escalation `
      + 'witness is ambiguous',
    );
  }
  const bond = bonds[0];
  // r9-2: the bond's IDENTITY is part of the request hash, so it must be bound
  // to the challenge record the witness selects. The filter above matches on
  // `bondProofHash` alone, and `bondTxid` was carried into the preimage and
  // never compared with the case: a bonded challenger could name ANY txid and
  // the resulting `requestHash` (the append-only log's only record of the
  // request) committed to a bond the case never bound — the r8-2 "unbound claim"
  // family one field over, on the value a host reads to decide which bond the
  // escalation is made under. One challenge record carries both halves
  // (`CourtChallengeRecord.bondTxid`), so the pairing is checkable here.
  if (normalised.bondTxid !== bond.bondTxid) {
    throw new CourtConfirmationTransitionError(
      `escalation request names bond txid ${normalised.bondTxid} but the accepted challenge carrying `
      + `its witness is bond ${bond.bondTxid} — the request hash would commit to a bond this case `
      + 'never bound (r9-2)',
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new CourtConfirmationTransitionError('escalation event now must be a non-negative safe integer');
  }
  const event: Extract<CourtConfirmationMachineEvent, { type: 'escalate' }> = {
    type: 'escalate',
    authority: 'challenger',
    challengerIdx: bond.idx,
    challengerPubkey: normalised.challengerPubkey,
    requestHash: hashCourtEscalationRequest(normalised),
    bondProofHash: normalised.bondProofHash,
    ...(normalised.roundBondProofHash === null
      ? {}
      : { roundBondProofHash: normalised.roundBondProofHash }),
    roundIndex: state.ladderRound + 1,
    now,
  };
  return event;
}
