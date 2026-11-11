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
 * Purity: pure functions; no I/O, no clock, no randomness.
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { HEX_32, isRecord } from './courtEventParseCore';
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

function assertHex32(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtConfirmationTransitionError(
      `escalation request ${field} must be 32-byte lowercase hex`,
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
  if (typeof input.caseId !== 'string' || input.caseId.trim() === '') {
    throw new CourtConfirmationTransitionError('escalation request caseId must be a non-empty string');
  }
  if (
    !Number.isSafeInteger(input.round)
    || input.round < 1
    || input.round > MAX_ESCALATION_REQUEST_ROUND
  ) {
    throw new CourtConfirmationTransitionError(
      `escalation request round must be an integer in 1..${MAX_ESCALATION_REQUEST_ROUND} `
      + `(got ${String(input.round)})`,
    );
  }
  const roundBondProofHash = input.roundBondProofHash == null
    ? null
    : assertHex32(input.roundBondProofHash, 'round_bond_proof_hash');
  if (!Number.isSafeInteger(input.signedAtSec) || input.signedAtSec < 0) {
    throw new CourtConfirmationTransitionError(
      'escalation request signedAtSec must be a non-negative safe integer',
    );
  }
  return {
    caseId: input.caseId.trim(),
    round: input.round,
    challengerPubkey: assertHex32(input.challengerPubkey, 'challenger_pubkey'),
    bondTxid: assertHex32(input.bondTxid, 'bond_txid'),
    bondProofHash: assertHex32(input.bondProofHash, 'bond_proof_hash'),
    roundBondProofHash,
    eventId: assertHex32(input.eventId, 'event_id'),
    signedAtSec: input.signedAtSec,
    concession: input.concession === true,
  };
}

/**
 * The canonical preimage: `domain ‖ 0x00 ‖ caseId ‖ round ‖ challengerPubkey ‖
 * bondTxid ‖ bondProofHash ‖ roundBondProofHash ‖ eventId ‖ signedAtSec ‖
 * concession`, fields joined by `\u0000`.
 *
 * The round-bond slot is `'-'` when the request carries none — a sentinel no
 * hex32 value can equal, so "absent" and "present" can never hash the same.
 */
export function courtEscalationRequestPreimage(request: CourtEscalationRequest): string {
  return [
    request.caseId.trim(),
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
 * Parse the canonical wire form, fail-closed.
 *
 * Accepts a JSON string or an already-parsed object. Unknown fields are a
 * REFUSAL (not ignored): `additionalProperties: false` is the point of a wire
 * shape, and a peer that silently drops a field is how H-6 happened. A missing
 * `roundBondProofHash` is normalised to `null` (the legacy shape); a missing
 * `concession` to `false`.
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
  }
  if (!isRecord(value)) {
    throw new CourtConfirmationTransitionError('escalation request must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!(WIRE_FIELDS as readonly string[]).includes(key)) {
      throw new CourtConfirmationTransitionError(`escalation request has an unknown field ${key}`);
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
 * Build the reducer's `escalate` event from a transported request.
 *
 * The split is deliberate: the wire supplies the challenger's claims; the CASE
 * supplies everything the challenger must not choose — the roster index that
 * owns the membership bond (`challengerIdx`), the round being opened
 * (`ladderRound + 1`), and the host clock (`now`). Every field of the reducer's
 * event is filled, so a host cannot drop the round bond on the way in.
 *
 * @throws {@link CourtConfirmationTransitionError} when the case has no
 *         accepted challenge carrying the request's membership bond.
 */
export function escalationRequestToMachineEvent(
  state: CourtConfirmationMachineState,
  request: CourtEscalationRequest,
  now: number,
): Extract<CourtConfirmationMachineEvent, { type: 'escalate' }> {
  const normalised = buildCourtEscalationRequest(request);
  const bond = state.challenges.find((c) => c.bondProofHash === normalised.bondProofHash);
  if (!bond) {
    throw new CourtConfirmationTransitionError(
      'no accepted challenge bond to bind an escalation witness to',
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
