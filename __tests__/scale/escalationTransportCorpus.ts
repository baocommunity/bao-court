// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 10 — escalation-request TRANSPORT fuzz (v0.14.0 wire surface,
 * `courtEscalationRequest.ts`).
 *
 * Every corpus unit is ONE challenger escalation request driven through the
 * whole transport, in the order a host runs it:
 *
 *     build / parse  →  serialize  →  parse  →  escalationRequestToMachineEvent
 *                    →  reduceCourtConfirmationMachine
 *
 * The corpus rotates a 50-row wire matrix (boundary ids, duplicate JSON keys,
 * prototype-pollution attempts, wrong-type fields, the `'-'` preimage sentinel,
 * and host-binding disagreements) and randomises the case it runs against, so
 * the corpus is thousands of DISTINCT requests over the pooled case shapes
 * (ladder round 1..4 × strict/legacy × break-glass/host · roster 3..5).
 *
 * WHAT IT ASSERTS (T1–T7):
 *
 *   T1  no raw throw escapes ANY stage — every refusal is the module's OWN
 *       typed `CourtConfirmationTransitionError` (never a TypeError, never
 *       silence);
 *   T2  the accept/refuse decision matches the row's expectation at the row's
 *       stage (wire, binding, or reducer);
 *   T3  `parse(serialize(r))` round-trips to the same normalised request for
 *       every request the wire accepts;
 *   T4  DIGEST INJECTIVITY: no two distinct canonical preimages produce one
 *       request hash (a digest map over the whole corpus; a repeated digest
 *       with a different preimage is a collision — the r7 H-6 / r8-1 defect);
 *   T5  no ACCEPTED request carries a claim the host binding contradicts:
 *       the minted event's `challengerPubkey` is the authenticated key, its
 *       `roundIndex` is `ladderRound + 1`, and its `requestHash` is the
 *       digest of the request that was mapped;
 *   T6  a mapped event that reaches the reducer either advances the case to
 *       `ladder_pending` with exactly one new frozen `escalationLog` record
 *       (carrying the request's per-round witness) or is refused with a typed
 *       error — never a silent no-op, never a raw error;
 *   T7  the demonstrated collision hazards are real and stay prevented:
 *       `TextEncoder` maps a lone surrogate and U+FFFD to the SAME bytes, and
 *       NFC/NFD differ in bytes — so the codec's canonical-UTF-8 refusal (not
 *       luck) is what keeps the digests injective.
 *
 * Unit of the corpus: one request. A failure label carries the unit seed and
 * the row name, so the exact byte string is reproducible from the artifact.
 */

import {
  CourtConfirmationTransitionError,
  challengerEscalationEvent,
  createCourtConfirmationMachine,
  hashCourtConfirmation,
  hostEscalationEvent,
  reduceCourtConfirmationMachine,
  type CourtConfirmationMachineEvent,
  type CourtConfirmationMachineState,
} from '../../courtConfirmationMachine';
import {
  MAX_ESCALATION_CASE_ID_BYTES,
  MAX_ESCALATION_REQUEST_ROUND,
  buildCourtEscalationRequest,
  courtEscalationRequestPreimage,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
  type CourtEscalationBinding,
  type CourtEscalationRequest,
} from '../../courtEscalationRequest';
import { MAX_LADDER_ROUNDS } from '../../confirmationMachineCore';
import { childRng, int } from '../helpers/rng';
import { CampaignReporter, nowMs, timingMetrics, type CampaignResult } from './corpus';

const SESSION = '1a'.repeat(32);
const PROPOSAL = '3c'.repeat(32);
const OUTCOMES = ['YES', 'NO'] as const;
const BASE_CLOCK = 1_700_000_000;

/**
 * A deterministic 32-byte lowercase-hex id from a label (no CSPRNG — campaign
 * rule). Four chained FNV-1a folds fill the 64 hex digits, so distinct labels
 * collide with probability ~2^-128 (an 8-digit repeat would collide inside a
 * 200,000-unit corpus).
 */
function id(seed: number, label: string): string {
  const text = `${seed}:${label}`;
  let out = '';
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let word = 0; word < 8; word += 1) {
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ Math.imul(word + 1, 0x9e3779b9)) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/** Uppercase hex that is guaranteed to carry LETTERS (casing-invalid, shape-valid). */
const UPPERCASE_HEX = 'AB'.repeat(32);

const textEncoder = new TextEncoder();

/** The sentinel the preimage uses for an ABSENT per-round bond. */
const ABSENT_ROUND_BOND = '-';

/** A degenerate but well-formed hex32 ("looks like" the sentinel slot). */
const ZERO_HASH = '0'.repeat(64);

/** A pool case parked at `round_resolved`, ready for one escalation. */
interface PoolCase {
  /** Case id the host routes on (never part of machine state). */
  readonly caseId: string;
  readonly state: CourtConfirmationMachineState;
  readonly bond: { readonly idx: number; readonly bondTxid: string; readonly bondProofHash: string };
  readonly requireRoundBond: boolean;
  readonly hostEscalation: boolean;
  readonly rosterSize: number;
}

/**
 * Drive a REAL case to `round_resolved` at ladder round `targetRound`
 * (`targetRound < maxLadderRounds`, so the machine parks instead of settling).
 * Every step goes through the reducer — the pool is never hand-built.
 */
function drivePoolCase(opts: {
  readonly seed: number;
  readonly caseId: string;
  readonly rosterSize: number;
  readonly targetRound: number;
  readonly challengers: number;
  readonly requireRoundBond: boolean;
  readonly hostEscalation: boolean;
}): PoolCase {
  const roster = Array.from({ length: opts.rosterSize }, (_, i) => i + 1);
  const confirmDeadline = BASE_CLOCK + 1_000;
  const challengeDeadline = BASE_CLOCK + 2_000;
  let state = createCourtConfirmationMachine({
    sessionHash: SESSION,
    proposalHash: PROPOSAL,
    proposedOutcome: 'YES',
    allowedOutcomes: [...OUTCOMES],
    participantIndices: roster,
    confirmQuorum: 1,
    confirmDeadline,
    challengeDeadline,
    maxLadderRounds: opts.targetRound + 1,
    ...(opts.hostEscalation ? { hostEscalation: true } : {}),
    ...(opts.requireRoundBond ? { requireRoundBond: true } : {}),
  });
  const reduce = (event: CourtConfirmationMachineEvent): void => {
    state = reduceCourtConfirmationMachine(state, event);
  };

  roster.forEach((idx, offset) => {
    reduce({
      type: 'accept_confirmation',
      idx,
      confirmHash: hashCourtConfirmation({ sessionHash: SESSION, proposalHash: PROPOSAL, idx }),
      eventId: id(opts.seed, `confirmation-${idx}`),
      now: BASE_CLOCK + 1 + offset,
    });
  });
  reduce({ type: 'close_confirmations', now: confirmDeadline });
  reduce({ type: 'open_challenge_window', now: confirmDeadline + 10 });

  const bonds: { idx: number; bondTxid: string; bondProofHash: string }[] = [];
  for (let c = 0; c < opts.challengers; c += 1) {
    const idx = roster[c % roster.length]!;
    const bond = {
      idx,
      bondTxid: id(opts.seed, `bond-txid-${c}`),
      bondProofHash: id(opts.seed, `bond-proof-${c}`),
    };
    bonds.push(bond);
    reduce({
      type: 'accept_challenge',
      idx,
      bondTxid: bond.bondTxid,
      bondProofHash: bond.bondProofHash,
      eventId: id(opts.seed, `challenge-${c}`),
      now: confirmDeadline + 100 + c,
    });
  }
  reduce({ type: 'close_challenge_window', now: challengeDeadline });

  let clock = challengeDeadline + 100;
  for (let round = 1; round <= opts.targetRound; round += 1) {
    const voteDeadline = clock + 1_000;
    reduce({ type: 'open_ladder_round', round, voteDeadline, now: clock });
    roster.forEach((idx, offset) => {
      reduce({
        type: 'accept_mass_vote',
        idx,
        outcome: 'NO',
        eventId: id(opts.seed, `vote-${round}-${idx}`),
        now: clock + 1 + offset,
      });
    });
    reduce({ type: 'close_ladder_round', now: voteDeadline });
    reduce({ type: 'resolve_round', now: voteDeadline + 1 });
    clock = voteDeadline + 2;
    if (round < opts.targetRound) {
      reduce(
        opts.hostEscalation
          ? hostEscalationEvent(state, clock)
          : challengerEscalationEvent(state, clock, {
            challengerIdx: bonds[0]!.idx,
            challengerPubkey: id(opts.seed, 'escalation-pubkey'),
            requestHash: id(opts.seed, `escalation-request-${round}`),
            ...(opts.requireRoundBond ? { roundBondProofHash: id(opts.seed, `round-bond-${round}`) } : {}),
          }),
      );
      clock += 1;
    }
  }

  return {
    caseId: opts.caseId,
    state,
    bond: bonds[0]!,
    requireRoundBond: opts.requireRoundBond,
    hostEscalation: opts.hostEscalation,
    rosterSize: opts.rosterSize,
  };
}

/**
 * THE POOL: ladder round 1..4 × strict/legacy × break-glass/default ×
 * roster 3/5. 32 driven cases, built once per run.
 */
function buildPool(): PoolCase[] {
  const pool: PoolCase[] = [];
  let index = 0;
  for (let targetRound = 1; targetRound <= 4; targetRound += 1) {
    for (const requireRoundBond of [false, true]) {
      for (const hostEscalation of [false, true]) {
        for (const rosterSize of [3, 5]) {
          index += 1;
          pool.push(drivePoolCase({
            seed: 900_000 + index,
            caseId: `case-${targetRound}-${requireRoundBond ? 'strict' : 'legacy'}-`
              + `${hostEscalation ? 'host' : 'default'}-n${rosterSize}`,
            rosterSize,
            targetRound,
            challengers: rosterSize === 3 ? 2 : 3,
            requireRoundBond,
            hostEscalation,
          }));
        }
      }
    }
  }
  return pool;
}

/** Per-unit wire context: the pool case, the unit seed and a live RNG. */
interface WireContext {
  readonly entry: PoolCase;
  readonly unitSeed: number;
  readonly r: () => number;
  /** Unit seed for the FRESH round bond, distinct from every membership bond. */
  readonly roundBond: string;
  readonly eventId: string;
  readonly signedAtSec: number;
  readonly pubkey: string;
}

/** The all-fields request input, before a row mutates it. */
interface RequestInput {
  caseId: string;
  round: number;
  challengerPubkey: string;
  bondTxid: string;
  bondProofHash: string;
  roundBondProofHash: string | null;
  eventId: string;
  signedAtSec: number;
  concession: boolean;
}

/** A wire payload a row produces: an object for `build`, text for `parse`. */
type WirePayload =
  | { readonly kind: 'object'; readonly input: unknown }
  | { readonly kind: 'text'; readonly text: string };

/** One row of the transport matrix. */
interface TransportRow {
  readonly name: string;
  /** Stage whose outcome `expect` describes. */
  readonly stage: 'wire' | 'binding' | 'reducer';
  readonly expect: 'accept' | 'reject';
  /** Restrict the pool case this row runs against. */
  readonly filter?: (entry: PoolCase) => boolean;
  readonly wire: (context: WireContext) => WirePayload;
  /** Host binding override (default: the truthful one). */
  readonly binding?: (context: WireContext) => unknown;
  /**
   * For TEXT payloads: what the OBJECT entry point decides. `refuse` (default)
   * means `JSON.parse` + `parse` also refuses; `accept` marks the rows where the
   * duplicate key is invisible to an already-parsed object — the r8-4 asymmetry
   * that makes the text scan the only defence.
   */
  readonly objectPath?: 'accept' | 'refuse';
}

const accept = (wire: TransportRow['wire']): TransportRow['wire'] => wire;
const rejectRow = (wire: TransportRow['wire']): TransportRow['wire'] => wire;

/** The valid object request a row starts from (flavour-aware). */
function baseInput(context: WireContext, overrides: Partial<RequestInput> = {}): RequestInput {
  const { entry, unitSeed, roundBond, eventId, signedAtSec, pubkey } = context;
  void unitSeed;
  return {
    caseId: entry.caseId,
    round: entry.state.ladderRound,
    challengerPubkey: pubkey,
    bondTxid: entry.bond.bondTxid,
    bondProofHash: entry.bond.bondProofHash,
    roundBondProofHash: roundBond,
    eventId,
    signedAtSec,
    concession: false,
    ...overrides,
  };
}

/** The canonical wire text of the valid request for a context. */
function baseText(context: WireContext, overrides: Partial<RequestInput> = {}): string {
  return serializeCourtEscalationRequest(buildCourtEscalationRequest(baseInput(context, overrides)));
}

/** Insert a raw member at the START of a JSON object text. */
function prependMember(text: string, member: string): string {
  return text.replace('{', `{${member},`);
}

/** Replace one `"key":value` pair with a raw replacement (first occurrence). */
function replaceMember(text: string, needle: string, replacement: string): string {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`campaign fixture: ${needle} not found in the wire text`);
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

const NUL = '\u0000';
const LONE_HIGH = '\uD800';
const LONE_LOW = '\uDC00';
const REPLACEMENT = '\uFFFD';
/** `é` precomposed (NFC) and decomposed (e + combining acute). */
const NFC_ACUTE = 'é';
const NFD_ACUTE = 'e\u0301';
/** A base letter carrying three stacked combining marks. */
const COMBINING = 'a\u0300\u0301\u0302';

/**
 * THE MATRIX. `stage` says where `expect` is decided: `wire` (build/parse),
 * `binding` (the host-binding checks in `escalationRequestToMachineEvent`) or
 * `reducer` (the machine's own enforcement, e.g. `requireRoundBond`).
 */
export const TRANSPORT_ROWS: readonly TransportRow[] = [
  // ── 1. valid requests ────────────────────────────────────────────────────
  {
    name: 'valid-fresh-round-bond',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({ kind: 'object', input: baseInput(context) })),
  },
  {
    name: 'valid-legacy-null-round-bond',
    stage: 'wire',
    expect: 'accept',
    filter: (entry) => !entry.requireRoundBond && !entry.hostEscalation,
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: null }),
    })),
  },
  {
    name: 'valid-round-bond-as-text',
    stage: 'wire',
    expect: 'accept',
    objectPath: 'accept',
    wire: accept((context) => ({ kind: 'text', text: baseText(context) })),
  },
  // ── 2. the wire's own enforcement of the per-round bond ──────────────────
  {
    name: 'strict-case-null-round-bond-refused-by-reducer',
    stage: 'reducer',
    expect: 'reject',
    // The WIRE accepts (the mapper validates shape, not policy); the REDUCER
    // refuses because the case sets requireRoundBond (R31/R33). This is the
    // transport-before-enforcement seam v0.14.0 exists to close.
    filter: (entry) => entry.requireRoundBond && !entry.hostEscalation,
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: null }),
    })),
  },
  {
    name: 'break-glass-case-null-round-bond-accepted',
    stage: 'reducer',
    expect: 'accept',
    // A break-glass case lets the HOST open rounds free, so a challenger
    // without a round bond prices nothing extra (documented compatibility).
    filter: (entry) => entry.hostEscalation,
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: null }),
    })),
  },
  {
    name: 'round-bond-equals-membership-bond-refused',
    stage: 'reducer',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: context.entry.bond.bondProofHash }),
    })),
  },
  // ── 3. caseId byte boundaries ────────────────────────────────────────────
  {
    name: 'caseid-256-ascii',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: 'a'.repeat(MAX_ESCALATION_CASE_ID_BYTES) }),
    })),
  },
  {
    name: 'caseid-257-ascii',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: 'a'.repeat(MAX_ESCALATION_CASE_ID_BYTES + 1) }),
    })),
  },
  {
    // 128 two-byte characters = EXACTLY 256 bytes but only 128 UTF-16 units —
    // the bound is on bytes, so a character-count implementation would let a
    // 512-byte id through.
    name: 'caseid-256-bytes-multibyte',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: 'é'.repeat(MAX_ESCALATION_CASE_ID_BYTES / 2) }),
    })),
  },
  {
    name: 'caseid-257-bytes-multibyte',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: `${'é'.repeat(MAX_ESCALATION_CASE_ID_BYTES / 2)}a` }),
    })),
  },
  // ── 4. NUL at every position (preimage field separator) ──────────────────
  {
    name: 'caseid-nul-start',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: `${NUL}case` }),
    })),
  },
  {
    name: 'caseid-nul-middle',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: `ca${NUL}se` }),
    })),
  },
  {
    name: 'caseid-nul-end',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: `case${NUL}` }),
    })),
  },
  // ── 5. lone surrogates at every position (TextEncoder → U+FFFD) ──────────
  ...(['start', 'middle', 'end'] as const).map((where): TransportRow => ({
    name: `caseid-lone-surrogate-high-${where}`,
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, {
        caseId: where === 'start' ? `${LONE_HIGH}case`
          : where === 'middle' ? `ca${LONE_HIGH}se`
            : `case${LONE_HIGH}`,
      }),
    })),
  })),
  ...(['start', 'middle', 'end'] as const).map((where): TransportRow => ({
    name: `caseid-lone-surrogate-low-${where}`,
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, {
        caseId: where === 'start' ? `${LONE_LOW}case`
          : where === 'middle' ? `ca${LONE_LOW}se`
            : `case${LONE_LOW}`,
      }),
    })),
  })),
  {
    // The REPLACEMENT CHARACTER is legal canonical UTF-8 — and the bytes the
    // surrogate above would encode to. It is accepted, which is exactly why the
    // surrogate must be REFUSED at the codec (T7).
    name: 'caseid-replacement-character',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: `case${REPLACEMENT}` }),
    })),
  },
  // ── 6. NFC / NFD / combining marks: distinct ids, distinct digests ───────
  {
    name: 'caseid-nfc',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({ kind: 'object', input: baseInput(context, { caseId: `caf${NFC_ACUTE}` }) })),
  },
  {
    name: 'caseid-nfd',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({ kind: 'object', input: baseInput(context, { caseId: `caf${NFD_ACUTE}` }) })),
  },
  {
    name: 'caseid-combining-marks',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({ kind: 'object', input: baseInput(context, { caseId: `c${COMBINING}se` }) })),
  },
  // ── 7. emptiness / trimming ──────────────────────────────────────────────
  {
    name: 'caseid-empty',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({ kind: 'object', input: baseInput(context, { caseId: '' }) })),
  },
  {
    name: 'caseid-whitespace-only',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({ kind: 'object', input: baseInput(context, { caseId: ' \t\n ' }) })),
  },
  {
    name: 'caseid-surrounding-whitespace-trimmed',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { caseId: `  ${context.entry.caseId}\t` }),
    })),
  },
  // ── 8. the `'-'` preimage sentinel ───────────────────────────────────────
  {
    name: 'hash-sentinel-as-value',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: ABSENT_ROUND_BOND }),
    })),
  },
  {
    name: 'hash-sentinel-padded',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: ABSENT_ROUND_BOND.repeat(64) }),
    })),
  },
  {
    // A well-formed hex32 that is degenerate ("looks like" the sentinel slot):
    // accepted, and its digest must differ from the absent-bond digest.
    name: 'hash-degenerate-zero',
    stage: 'wire',
    expect: 'accept',
    wire: accept((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: ZERO_HASH }),
    })),
  },
  {
    name: 'hash-uppercase',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { roundBondProofHash: UPPERCASE_HEX }),
    })),
  },
  // ── 9. duplicate JSON keys (top level AND nested) ────────────────────────
  {
    name: 'dup-key-caseid-top-level',
    stage: 'wire',
    expect: 'reject',
    objectPath: 'accept',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), `"caseId":${JSON.stringify(context.entry.caseId)}`),
    })),
  },
  {
    name: 'dup-key-roundbond-null-then-real',
    stage: 'wire',
    expect: 'reject',
    objectPath: 'accept',
    // The r8-4 shape: one digest covers two byte strings, and an audit reading
    // the raw body sees a witness the machine never saw.
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), '"roundBondProofHash":null'),
    })),
  },
  {
    name: 'dup-key-caseid-escaped-spelling',
    stage: 'wire',
    expect: 'reject',
    objectPath: 'accept',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), `"c\\u0061seId":${JSON.stringify(context.entry.caseId)}`),
    })),
  },
  {
    name: 'dup-key-nested-in-unknown-field',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), '"meta":{"a":1,"a":2}'),
    })),
  },
  {
    name: 'dup-key-nested-in-concession',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: replaceMember(baseText(context), '"concession":false', '"concession":{"a":1,"a":2}'),
    })),
  },
  {
    name: 'dup-key-nested-in-array',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), '"evidenceIds":[{"a":1,"a":2}]'),
    })),
  },
  // ── 10. prototype pollution ──────────────────────────────────────────────
  {
    name: 'proto-pollution-__proto__',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), '"__proto__":{"polluted":true}'),
    })),
  },
  {
    name: 'proto-pollution-constructor',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), '"constructor":{"prototype":{"polluted":true}}'),
    })),
  },
  {
    name: 'proto-pollution-prototype-key',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'text',
      text: prependMember(baseText(context), '"prototype":{"polluted":true}'),
    })),
  },
  // ── 11. wrong-type fields ────────────────────────────────────────────────
  ...([
    ['round-string', { round: '1' }],
    ['round-float', { round: 1.5 }],
    ['round-zero', { round: 0 }],
    ['round-six', { round: MAX_LADDER_ROUNDS + 1 }],
    ['round-null', { round: null }],
    ['pubkey-null', { challengerPubkey: null }],
    ['pubkey-number', { challengerPubkey: 42 }],
    ['pubkey-uppercase', { challengerPubkey: 'AB'.repeat(32) }],
    ['bondtxid-array', { bondTxid: [] }],
    ['bondproof-object', { bondProofHash: {} }],
    ['eventid-empty', { eventId: '' }],
    ['signedat-negative', { signedAtSec: -1 }],
    ['signedat-nan', { signedAtSec: Number.NaN }],
    ['signedat-string', { signedAtSec: '1700000000' }],
    ['signedat-huge', { signedAtSec: Number.MAX_SAFE_INTEGER + 2 }],
    ['caseid-number', { caseId: 7 }],
    ['caseid-array', { caseId: ['case'] }],
    ['caseid-object', { caseId: { toString: () => 'case' } }],
  ] as const).map(([suffix, override]): TransportRow => ({
    name: `wrong-type-${suffix}`,
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, override as unknown as Partial<RequestInput>),
    })),
  })),
  {
    name: 'wrong-type-concession-string',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { concession: 'true' as unknown as boolean }),
    })),
  },
  {
    name: 'wrong-type-concession-number',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { concession: 1 as unknown as boolean }),
    })),
  },
  {
    name: 'wrong-type-concession-null',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: baseInput(context, { concession: null as unknown as boolean }),
    })),
  },
  // ── 12. shape violations at the parse boundary ──────────────────────────
  {
    name: 'unknown-field',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: { ...baseInput(context), extraClaim: 'yes' },
    })),
  },
  {
    name: 'unknown-field-nested-known-name',
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => ({
      kind: 'object',
      input: { ...baseInput(context), nested: { caseId: context.entry.caseId } },
    })),
  },
  ...([
    ['caseId', 'missing-caseid'],
    ['round', 'missing-round'],
    ['challengerPubkey', 'missing-challengerpubkey'],
    ['bondTxid', 'missing-bondtxid'],
    ['bondProofHash', 'missing-bondproofhash'],
    ['eventId', 'missing-eventid'],
    ['signedAtSec', 'missing-signedatsec'],
  ] as const).map(([field, name]): TransportRow => ({
    name,
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow((context) => {
      const input = baseInput(context) as unknown as Record<string, unknown>;
      delete input[field];
      return { kind: 'object', input };
    }),
  })),
  ...([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['boolean', true],
    ['array', [{ caseId: 'x' }]],
    ['string-null', 'null'],
    ['string-array', '[]'],
    ['string-truncated', '{"caseId":'],
    ['string-empty', ''],
    ['string-number', '17'],
  ] as const).map(([suffix, payload]): TransportRow => ({
    name: `parse-nonobject-${suffix}`,
    stage: 'wire',
    expect: 'reject',
    wire: rejectRow(() => ({ kind: 'object', input: payload })),
  })),
  // ── 13. host-binding disagreements (r8-2) ───────────────────────────────
  {
    name: 'binding-caseid-mismatch',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: (context) => ({
      caseId: `${context.entry.caseId}-other`,
      authenticatedPubkey: context.pubkey,
    }),
  },
  {
    name: 'binding-caseid-cross-case',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: () => ({ caseId: 'a-different-case', authenticatedPubkey: undefined }),
  },
  {
    name: 'binding-pubkey-mismatch',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: (context) => ({
      caseId: context.entry.caseId,
      authenticatedPubkey: id(context.unitSeed, 'some-other-wallet'),
    }),
  },
  {
    name: 'binding-pubkey-uppercase',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: (context) => ({
      caseId: context.entry.caseId,
      authenticatedPubkey: context.pubkey.toUpperCase(),
    }),
  },
  {
    name: 'binding-missing',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: () => undefined,
  },
  {
    name: 'binding-null',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: () => null,
  },
  {
    name: 'binding-empty-caseid',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: (context) => ({ caseId: '   ', authenticatedPubkey: context.pubkey }),
  },
  {
    name: 'binding-round-mismatch-next',
    stage: 'binding',
    expect: 'reject',
    filter: (entry) => entry.state.ladderRound < MAX_ESCALATION_REQUEST_ROUND,
    wire: (context) => ({
      kind: 'object',
      input: baseInput(context, { round: context.entry.state.ladderRound + 1 }),
    }),
  },
  {
    name: 'binding-round-mismatch-previous',
    stage: 'binding',
    expect: 'reject',
    filter: (entry) => entry.state.ladderRound > 1,
    wire: (context) => ({
      kind: 'object',
      input: baseInput(context, { round: context.entry.state.ladderRound - 1 }),
    }),
  },
  {
    name: 'binding-foreign-bond',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({
      kind: 'object',
      input: baseInput(context, { bondProofHash: id(context.unitSeed, 'never-accepted-bond') }),
    }),
  },
  {
    // r46-1 (found by THIS campaign): a request the challenger signed as a
    // CONCESSION was minted as an escalation — opening a rung they never
    // authorised, spending a bond witness in their name and writing them into
    // the append-only log as the escalator. Refused now.
    name: 'concession-must-not-escalate',
    stage: 'binding',
    expect: 'reject',
    wire: (context) => ({ kind: 'object', input: baseInput(context, { concession: true }) }),
  },
  {
    // The truthful binding, with the host's routing id carrying the padding a
    // host's own storage might: the mapper trims both sides, so it accepts.
    name: 'binding-caseid-padded-host-side',
    stage: 'binding',
    expect: 'accept',
    wire: (context) => ({ kind: 'object', input: baseInput(context) }),
    binding: (context) => ({
      caseId: `  ${context.entry.caseId} `,
      authenticatedPubkey: context.pubkey,
    }),
  },
];

/** `MAX_ESCALATION_MAX_ROUND` was folded into the import above. */

const ROW_NAMES = TRANSPORT_ROWS.map((row) => row.name);

interface TransportStats {
  acceptedWire: number;
  rejectedWire: number;
  mappedEvents: number;
  bindingRefusals: number;
  reducerAccepted: number;
  reducerRefused: number;
  typedRefusals: number;
  rawErrors: number;
  roundTrips: number;
  digests: number;
  digestCollisions: number;
  bindingViolations: number;
  pollutionLeaks: number;
  surrogateHazards: number;
  rowsByOutcome: Record<string, number>;
  perUnitMs: number[];
}

/** Outcome of one product call: a value or a caught error, never a throw. */
type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Run one transport unit. */
function runTransportUnit(
  reporter: CampaignReporter,
  pool: readonly PoolCase[],
  digests: Map<string, string>,
  unitSeed: number,
  rowIndex: number,
  stats: TransportStats,
): void {
  const row = TRANSPORT_ROWS[rowIndex]!;
  const r = childRng(unitSeed, 'escalation-transport');
  const candidates = row.filter === undefined ? pool : pool.filter(row.filter);
  if (candidates.length === 0) {
    reporter.fail(
      `transport#${unitSeed} [${row.name}]`,
      'SETUP: the row filtered out every pooled case, so the row never runs',
    );
    return;
  }
  const entry = candidates[Math.floor((unitSeed - 1) / ROW_NAMES.length) % candidates.length]!;
  const context: WireContext = {
    entry,
    unitSeed,
    r,
    roundBond: id(unitSeed, 'fresh-round-bond'),
    eventId: id(unitSeed, 'wire-event-id'),
    signedAtSec: BASE_CLOCK + (unitSeed % 1_000_000),
    pubkey: id(unitSeed, 'challenger-pubkey'),
  };
  const label = `transport#${unitSeed} [${row.name}]`;
  const started = nowMs();
  stats.rowsByOutcome[`${row.name}:${row.expect}`] = (stats.rowsByOutcome[`${row.name}:${row.expect}`] ?? 0) + 1;

  // ── stage 1: the wire (build or parse) ───────────────────────────────────
  let payload: WirePayload;
  try {
    payload = row.wire(context);
  } catch (error) {
    reporter.fail(label, `FIXTURE: the row could not build its wire payload: ${describe(error)}`);
    return;
  }
  const wireAttempt: Attempt<CourtEscalationRequest> = attempt(() => (
    payload.kind === 'text'
      ? parseCourtEscalationRequest(payload.text)
      : parseCourtEscalationRequest(payload.input)
  ));

  // ── T2 (dual entry): the object and text entry points must agree ──────────
  // A host that `JSON.parse`s a body and a host that hands the raw text to the
  // codec must reach the SAME verdict — except on the rows where the defect is
  // unrepresentable in an object (a duplicate key), which is why the text scan
  // exists at all.
  if (payload.kind === 'object') {
    const textForm = attempt(() => JSON.stringify(payload.input));
    const textAttempt = attempt(() => parseCourtEscalationRequest(
      textForm.ok ? textForm.value : payload.input,
    ));
    reporter.equals(
      label,
      textAttempt.ok,
      wireAttempt.ok,
      'T2: an object payload and its JSON text must reach the same accept/refuse decision',
    );
  } else {
    const parsedObject = attempt(() => JSON.parse(payload.text));
    const objectAttempt = parsedObject.ok
      ? attempt(() => parseCourtEscalationRequest(parsedObject.value))
      : { ok: false, error: parsedObject.error } as const;
    reporter.equals(
      label,
      objectAttempt.ok,
      row.objectPath === 'accept',
      row.objectPath === 'accept'
        ? 'T2: an already-parsed object CANNOT see a duplicate key — only the text scan can (r8-4)'
        : 'T2: the object entry point must refuse this payload too',
    );
  }

  if (!wireAttempt.ok) {
    stats.rejectedWire += 1;
    // ── T1: every wire refusal is the codec's OWN typed error ──
    if (!(wireAttempt.error instanceof CourtConfirmationTransitionError)) {
      stats.rawErrors += 1;
      reporter.fail(label, `T1: the wire refusal was UNTYPED: ${describe(wireAttempt.error)}`);
      return;
    }
    stats.typedRefusals += 1;
    if (row.stage === 'wire' && row.expect === 'accept') {
      reporter.fail(label, `T2: a LEGAL request was refused: ${describe(wireAttempt.error)}`);
      return;
    }
    // Boundary-specific T7 probes on the refused shapes.
    runRowProbes(reporter, label, row, context, digests, stats);
    stats.perUnitMs.push(round3(nowMs() - started));
    return;
  }
  stats.acceptedWire += 1;
  if (row.stage === 'wire' && row.expect === 'reject') {
    reporter.fail(label, 'T2: an ILLEGAL request was ACCEPTED by the wire');
    return;
  }
  const request = wireAttempt.value;

  // ── T3: the canonical round-trip ─────────────────────────────────────────
  const roundTrip = attempt(() => parseCourtEscalationRequest(serializeCourtEscalationRequest(request)));
  if (!roundTrip.ok) {
    reporter.fail(label, `T3: parse(serialize(r)) threw: ${describe(roundTrip.error)}`);
    return;
  }
  reporter.ok(
    label,
    courtEscalationRequestPreimage(roundTrip.value) === courtEscalationRequestPreimage(request),
    'T3: parse(serialize(r)) must reproduce the same canonical preimage',
  );
  reporter.ok(
    label,
    serializeCourtEscalationRequest(roundTrip.value) === serializeCourtEscalationRequest(request),
    'T3: the wire form must be byte-identical after a round-trip',
  );
  stats.roundTrips += 1;
  // ── T4: digest injectivity over the whole corpus ─────────────────────────
  const digestAttempt = attempt(() => hashCourtEscalationRequest(request));
  if (!digestAttempt.ok) {
    reporter.fail(label, `T4: hashing an accepted request threw: ${describe(digestAttempt.error)}`);
    return;
  }
  const digest = digestAttempt.value;
  const preimage = courtEscalationRequestPreimage(request);
  const previous = digests.get(digest);
  if (previous === undefined) {
    digests.set(digest, preimage);
    stats.digests += 1;
  } else if (previous !== preimage) {
    stats.digestCollisions += 1;
    reporter.fail(
      label,
      `T4: DIGEST COLLISION — two distinct preimages share request hash ${digest.slice(0, 16)}…`,
    );
    return;
  }
  // ── T4 (arity): the preimage is a FIXED 9-slot field vector ───────────────
  // This is what makes a NUL inside `caseId` a boundary hazard, and therefore
  // what the codec's NUL refusal protects: a 10-slot preimage would mean a field
  // boundary was forged.
  reporter.equals(label, preimage.split('\u0000').length, 9, 'T4: the canonical preimage must have exactly 9 fields');
  runRowProbes(reporter, label, row, context, digests, stats);

  // ── stage 2: the host binding ────────────────────────────────────────────
  const binding: unknown = row.binding === undefined
    ? ({ caseId: entry.caseId, authenticatedPubkey: context.pubkey } satisfies CourtEscalationBinding)
    : row.binding(context);
  const mapAttempt = attempt(() => escalationRequestToMachineEvent(
    entry.state,
    request,
    entry.state.latestTimestamp + 1 + (unitSeed % 1_000),
    binding as CourtEscalationBinding,
  ));
  if (!mapAttempt.ok) {
    stats.bindingRefusals += 1;
    if (!(mapAttempt.error instanceof CourtConfirmationTransitionError)) {
      stats.rawErrors += 1;
      reporter.fail(label, `T1: the binding refusal was UNTYPED: ${describe(mapAttempt.error)}`);
      return;
    }
    stats.typedRefusals += 1;
    if (row.stage === 'binding' && row.expect === 'accept') {
      reporter.fail(label, `T2: a correctly bound request was refused: ${describe(mapAttempt.error)}`);
      return;
    }
    if (row.stage === 'reducer' && row.expect === 'accept') {
      reporter.fail(label, `T2: a legal escalation was refused at the binding: ${describe(mapAttempt.error)}`);
    }
    stats.perUnitMs.push(round3(nowMs() - started));
    return;
  }
  const event = mapAttempt.value;
  stats.mappedEvents += 1;
  if (row.stage === 'binding' && row.expect === 'reject') {
    reporter.fail(label, 'T2: a request whose binding DISAGREES was mapped to a machine event');
    return;
  }

  // ── T5: no accepted request carries a claim the binding contradicts ──────
  const bound = binding as CourtEscalationBinding;
  const claimViolations = [
    event.challengerPubkey === bound.authenticatedPubkey ? null : 'challengerPubkey ≠ authenticated key',
    request.caseId === bound.caseId.trim() ? null : 'caseId ≠ the case the host bound',
    event.roundIndex === entry.state.ladderRound + 1 ? null : 'roundIndex ≠ ladderRound + 1',
    event.requestHash === digest ? null : 'requestHash ≠ the digest of the mapped request',
    event.challengerIdx === entry.bond.idx ? null : 'challengerIdx ≠ the membership-bond owner',
    event.bondProofHash === request.bondProofHash ? null : 'bondProofHash ≠ the request witness',
    (event as { readonly roundBondProofHash?: string | null }).roundBondProofHash
      === (request.roundBondProofHash ?? undefined)
      ? null
      : 'roundBondProofHash ≠ the request witness',
    event.roundIndex === entry.state.ladderRound + 1 ? null : 'roundIndex ≠ ladderRound + 1',
  ].filter((value): value is string => value !== null);
  if (claimViolations.length > 0) {
    stats.bindingViolations += claimViolations.length;
    reporter.fail(label, `T5: an ACCEPTED request carries claims the binding contradicts: ${claimViolations.join('; ')}`);
    return;
  }
  reporter.check();

  // ── stage 3: the reducer ────────────────────────────────────────────────
  const logBefore = entry.state.escalationLog.length;
  const reduceAttempt = attempt(() => reduceCourtConfirmationMachine(entry.state, event));
  if (!reduceAttempt.ok) {
    stats.reducerRefused += 1;
    if (!(reduceAttempt.error instanceof CourtConfirmationTransitionError)) {
      stats.rawErrors += 1;
      reporter.fail(label, `T1: the reducer refusal was UNTYPED: ${describe(reduceAttempt.error)}`);
      return;
    }
    stats.typedRefusals += 1;
    if (row.stage !== 'reducer' || row.expect === 'accept') {
      reporter.fail(label, `T6: the reducer refused a mapped escalation: ${describe(reduceAttempt.error)}`);
    }
    stats.perUnitMs.push(round3(nowMs() - started));
    return;
  }
  const accepted = reduceAttempt.value;
  stats.reducerAccepted += 1;
  if (row.stage === 'reducer' && row.expect === 'reject') {
    reporter.fail(label, 'T6: the reducer ACCEPTED an escalation the case policy forbids');
    return;
  }
  reporter.equals(label, accepted.phase, 'ladder_pending', 'T6: an accepted escalation opens the next round');
  reporter.equals(label, accepted.escalationLog.length, logBefore + 1, 'T6: exactly one witness record appended');
  const record = accepted.escalationLog[accepted.escalationLog.length - 1]!;
  reporter.equals(label, record.round, entry.state.ladderRound + 1, 'T6: the record names the round it opened');
  reporter.equals(
    label,
    record.roundBondProofHash ?? null,
    request.roundBondProofHash,
    'T6: the record carries the request\'s per-round witness (R31)',
  );
  reporter.ok(label, Object.isFrozen(record), 'T6: the witness record is frozen');
  reporter.equals(label, entry.state.escalationLog.length, logBefore, 'T6: the input state is never mutated');
  stats.perUnitMs.push(round3(nowMs() - started));
}

/**
 * T7 probes for the boundary rows: the hazard must be real (the encodings
 * collide), and the codec — not luck — must be what prevents the collision.
 * Called on BOTH the refusal and the acceptance path, because a row's hazard
 * probe does not depend on its own outcome.
 */
function runRowProbes(
  reporter: CampaignReporter,
  label: string,
  row: TransportRow,
  context: WireContext,
  digests: Map<string, string>,
  stats: TransportStats,
): void {
  if (row.name.startsWith('caseid-lone-surrogate')) {
    // TextEncoder maps the unpaired surrogate to U+FFFD, so the two ids have
    // IDENTICAL bytes. The refusal above is the only thing keeping the digests
    // apart, so prove the bytes really do collide.
    const surrogateId = `case${LONE_HIGH}`;
    const replacementId = `case${REPLACEMENT}`;
    const surrogateBytes = textEncoder.encode(surrogateId);
    const replacementBytes = textEncoder.encode(replacementId);
    reporter.ok(
      label,
      surrogateBytes.length === replacementBytes.length
        && surrogateBytes.every((byte, at) => byte === replacementBytes[at]),
      'T7: the lone surrogate and U+FFFD must encode to IDENTICAL bytes (the collision the codec prevents)',
    );
    stats.surrogateHazards += 1;
    // And the legal twin hashes, to a digest no other preimage claimed.
    const twin = attempt(() => hashCourtEscalationRequest(buildCourtEscalationRequest(baseInput(context, {
      caseId: replacementId,
    }))));
    if (!twin.ok) {
      reporter.fail(label, `T7: the U+FFFD twin was refused, so the hazard probe is inconclusive: ${describe(twin.error)}`);
      return;
    }
    const prior = digests.get(twin.value);
    if (prior === undefined) {
      digests.set(twin.value, `twin:${replacementId}`);
      stats.digests += 1;
    }
  }
  if (row.name === 'hash-sentinel-as-value') {
    // The sentinel must never be a value: the preimage slot for an ABSENT bond
    // is exactly `'-'`, so a request carrying `'-'` as a real hash would hash
    // the same as one carrying none.
    const absent = courtEscalationRequestPreimage(buildCourtEscalationRequest(baseInput(context, {
      roundBondProofHash: null,
    })));
    const slots = absent.split('\u0000');
    reporter.equals(label, slots[5], ABSENT_ROUND_BOND, 'T7: the absent per-round bond slot is the `-` sentinel');
  }
  if (row.name === 'hash-degenerate-zero') {
    const absent = courtEscalationRequestPreimage(buildCourtEscalationRequest(baseInput(context, {
      roundBondProofHash: null,
    })));
    const zero = courtEscalationRequestPreimage(buildCourtEscalationRequest(baseInput(context, {
      roundBondProofHash: ZERO_HASH,
    })));
    reporter.ok(label, absent !== zero, 'T7: a degenerate real hash must not hash to the absent-bond preimage');
  }
  if (row.name === 'caseid-nfc' || row.name === 'caseid-nfd') {
    const nfc = textEncoder.encode(`caf${NFC_ACUTE}`);
    const nfd = textEncoder.encode(`caf${NFD_ACUTE}`);
    const sameBytes = nfc.length === nfd.length && nfc.every((byte, at) => byte === nfd[at]);
    reporter.ok(label, !sameBytes, 'T7: NFC and NFD spellings must NOT be byte-identical');
    const left = attempt(() => hashCourtEscalationRequest(buildCourtEscalationRequest(baseInput(context, { caseId: `caf${NFC_ACUTE}` }))));
    const right = attempt(() => hashCourtEscalationRequest(buildCourtEscalationRequest(baseInput(context, { caseId: `caf${NFD_ACUTE}` }))));
    if (left.ok && right.ok) {
      reporter.ok(label, left.value !== right.value, 'T4: NFC and NFD case ids must produce DIFFERENT request hashes');
      if (!digests.has(left.value)) { digests.set(left.value, 'nfc'); stats.digests += 1; }
      if (!digests.has(right.value)) { digests.set(right.value, 'nfd'); stats.digests += 1; }
    }
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Run the campaign: `size` transport units. The unit seed is `seed + index`,
 * so a failure label reproduces the exact request from the artifact.
 */
export function runEscalationTransportCampaign(opts: {
  readonly size: number;
  readonly seed?: number;
}): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('escalationTransport', 'requests', opts.size, seed);
  const pool = buildPool();
  for (const entry of pool) {
    if (entry.state.phase !== 'round_resolved') {
      reporter.fail(
        `pool:${entry.caseId}`,
        `SETUP: the pooled case did not park at round_resolved (phase ${entry.state.phase})`,
      );
    }
  }
  const digests = new Map<string, string>();
  const stats: TransportStats = {
    acceptedWire: 0,
    rejectedWire: 0,
    mappedEvents: 0,
    bindingRefusals: 0,
    reducerAccepted: 0,
    reducerRefused: 0,
    typedRefusals: 0,
    rawErrors: 0,
    roundTrips: 0,
    digests: 0,
    digestCollisions: 0,
    bindingViolations: 0,
    pollutionLeaks: 0,
    surrogateHazards: 0,
    rowsByOutcome: {},
    perUnitMs: [],
  };

  for (let index = 1; index <= opts.size; index += 1) {
    runTransportUnit(reporter, pool, digests, seed + index, (index - 1) % ROW_NAMES.length, stats);
  }

  // ── T7 (global): no prototype pollution leaked out of any parse ──────────
  const probe: Record<string, unknown> = {};
  if (probe.polluted !== undefined) {
    stats.pollutionLeaks += 1;
    reporter.fail('transport#global', 'T7: a parse attempt polluted Object.prototype');
  }
  reporter.ok(
    'transport#global',
    stats.pollutionLeaks === 0,
    'T7: no `__proto__`/`constructor` payload polluted a global prototype',
  );

  const wallMs = nowMs() - started;
  return reporter.finish(
    wallMs,
    {
      acceptedWire: stats.acceptedWire,
      rejectedWire: stats.rejectedWire,
      mappedEvents: stats.mappedEvents,
      bindingRefusals: stats.bindingRefusals,
      reducerAccepted: stats.reducerAccepted,
      reducerRefused: stats.reducerRefused,
      typedRefusals: stats.typedRefusals,
      rawErrors: stats.rawErrors,
      roundTrips: stats.roundTrips,
      distinctDigests: stats.digests,
      digestCollisions: stats.digestCollisions,
      bindingViolations: stats.bindingViolations,
      surrogateHazards: stats.surrogateHazards,
      rowsFired: Object.keys(stats.rowsByOutcome).length,
      ...timingMetrics(stats.perUnitMs),
    },
    [
      `wire matrix rows: ${TRANSPORT_ROWS.length} (${TRANSPORT_ROWS.filter((row) => row.expect === 'accept').length} accept, ${TRANSPORT_ROWS.filter((row) => row.expect === 'reject').length} reject)`,
      'pool: 32 REAL driven cases — ladder round 1..4 × strict/legacy × break-glass/default × roster 3/5, every state reached through the reducer',
      'digest injectivity is checked over EVERY accepted request in the run (digest → canonical preimage map)',
      'the lone-surrogate rows prove the TextEncoder → U+FFFD byte collision is real, so the canonical-UTF-8 refusal is what keeps digests injective',
      'T1: no raw throw escapes build/parse/serialize/map/reduce — every refusal is CourtConfirmationTransitionError',
    ],
  );
}
