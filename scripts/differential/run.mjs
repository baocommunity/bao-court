// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * DIFFERENTIAL HARNESS — the escalation request WIRE, round 49.
 *
 * Two independent implementations of one contract:
 *
 *   A. the SHIPPED TypeScript codec (`courtEscalationRequest.ts`, v0.14.2);
 *   B. `scripts/differential/wire_ref.py`, written from the prose in a
 *      different language, with stdlib primitives (hashlib, the stdlib JSON
 *      string scanner, explicit code-point sets) and its own canonical JSON
 *      writer.
 *
 * Every case in a seeded corpus is evaluated by BOTH and compared on four
 * axes: (a) accept/refuse, (b) the refusal CLASS (mapped — never the message
 * text), (c) the preimage bytes and the digest on accept, (d) the canonical
 * wire string and the mapped `escalate` event shape on accept. A disagreement
 * is always a finding: a bug in the shipped codec, a bug in the reference, or
 * an under-specified sentence both were reading differently. Nothing here
 * "makes them agree" — a disagreement is either fixed in the side that is
 * wrong or promoted to a spec sentence in `docs/DIFFERENTIAL_WIRE.md` §5 and
 * pinned on both sides.
 *
 * RUN
 *   npx tsx scripts/differential/run.mjs                 # 100 000 cases, writes the summary
 *   npx tsx scripts/differential/run.mjs --only          # 2 000 cases, CI/unit-test mode
 *   npx tsx scripts/differential/run.mjs --count 50000 --seed 7 --out /tmp/x.json
 *   python3 scripts/differential/wire_ref.py --selftest  # the reference alone (known answer)
 *
 * The reference is stdlib-only and is invoked as `python3`; the harness refuses
 * to silently pass when it is unavailable (`--allow-missing-python` exists only
 * so the unit test can SKIP, never so a campaign can claim coverage).
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  buildCourtEscalationRequest,
  courtEscalationRequestPreimage,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
} from '../../courtEscalationRequest.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REFERENCE = path.join(HERE, 'wire_ref.py');

/**
 * The closed set of refusal classes both sides are mapped onto. One class per
 * SEMANTIC refusal — a class is a decision ("this input is refused because the
 * case id is folded"), so comparing classes compares decisions, while comparing
 * messages would compare prose.
 */
export const REFUSAL_CLASSES = Object.freeze([
  'json', // the body text is not JSON
  'not_object',
  'duplicate_key',
  'unknown_field',
  'case_id_type_or_empty',
  'case_id_not_canonical',
  'case_id_nul',
  'case_id_whitespace',
  'case_id_too_long',
  'round',
  'hex32_round_bond_proof_hash',
  'hex32_challenger_pubkey',
  'hex32_bond_txid',
  'hex32_bond_proof_hash',
  'hex32_event_id',
  'signed_at',
  'concession_type',
  'binding_missing',
  'binding_pubkey_format',
  'binding_case_mismatch',
  'binding_pubkey_mismatch',
  'binding_round',
  'ladder_missing',
  'ladder_counters',
  'bond_none',
  'bond_ambiguous',
  'bond_txid',
  'now',
  'concession_not_escalation',
  'state_shape', // a tampered snapshot: typed refusal, never a raw TypeError
  'panic', // an untyped error escaped the fail-closed boundary
]);

const HEX32_FIELD_TO_CLASS = {
  round_bond_proof_hash: 'hex32_round_bond_proof_hash',
  challenger_pubkey: 'hex32_challenger_pubkey',
  bond_txid: 'hex32_bond_txid',
  bond_proof_hash: 'hex32_bond_proof_hash',
  event_id: 'hex32_event_id',
};

/**
 * Map a thrown TypeScript value onto a refusal class. Ordered: the first match
 * wins, so the specific patterns precede the general ones. The `code` field is
 * checked first — an error that is not the codec's own transition error is a
 * `panic` (an untyped escape), whatever its message says.
 */
export function classifyTsError(error) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code !== 'CONFIRMATION_TRANSITION') return 'panic';
  if (/repeats the field/.test(message)) return 'duplicate_key';
  if (/is not valid JSON/.test(message)) return 'json';
  if (/must be a JSON object/.test(message)) return 'not_object';
  // r49-d: the non-object descriptor and the tampered-snapshot guards. The
  // classes are the reference's, not the message's: a descriptor that is not an
  // object is the same decision as a body that is not an object.
  if (/escalation request must be an object/.test(message)) return 'not_object';
  if (/landed on a case snapshot that is not an object/.test(message)) return 'state_shape';
  if (/has no challenge ledger/.test(message)) return 'state_shape';
  if (/has an unknown field/.test(message)) return 'unknown_field';
  const hex = /escalation request (round_bond_proof_hash|challenger_pubkey|bond_txid|bond_proof_hash|event_id) must be 32-byte lowercase hex/.exec(message);
  if (hex) return HEX32_FIELD_TO_CLASS[hex[1]];
  if (/must be canonical UTF-8 \(no unpaired surrogates\)/.test(message)) return 'case_id_not_canonical';
  if (/must not contain U\+0000/.test(message)) return 'case_id_nul';
  if (/must not have leading or trailing whitespace/.test(message)) return 'case_id_whitespace';
  if (/exceeds 256 bytes/.test(message)) return 'case_id_too_long';
  if (/must be a non-empty string/.test(message)) return 'case_id_type_or_empty';
  if (/round must be an integer in 1\.\.5/.test(message)) return 'round';
  if (/signedAtSec must be a non-negative safe integer/.test(message)) return 'signed_at';
  if (/concession must be a boolean/.test(message)) return 'concession_type';
  if (/is a CONCESSION \(concession = true\)/.test(message)) return 'concession_not_escalation';
  if (/binding is required/.test(message)) return 'binding_missing';
  if (/binding authenticatedPubkey must be the 32-byte lowercase hex/.test(message)) return 'binding_pubkey_format';
  if (/a request must not cross cases/.test(message)) return 'binding_case_mismatch';
  if (/is not the pubkey the request authenticated as/.test(message)) return 'binding_pubkey_mismatch';
  if (/but the case is resolving round/.test(message)) return 'binding_round';
  if (/no open ladder round/.test(message)) return 'ladder_missing';
  if (/the round counters disagree/.test(message)) return 'ladder_counters';
  if (/no accepted challenge bond/.test(message)) return 'bond_none';
  if (/binds one bond proof hash to/.test(message)) return 'bond_ambiguous';
  if (/names bond txid/.test(message)) return 'bond_txid';
  if (/event now must be a non-negative safe integer/.test(message)) return 'now';
  return 'panic';
}

// ─── A. the shipped implementation ───────────────────────────────────────────

/** Canonicalise a JSON value so two sides' numbers/keys compare structurally. */
function canon(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canon);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
  return out;
}

const canonString = (value) => JSON.stringify(canon(value));

function tsAccept(request, extra = {}) {
  return {
    outcome: 'accept',
    code: null,
    preimage: courtEscalationRequestPreimage(request),
    digest: hashCourtEscalationRequest(request),
    serialized: serializeCourtEscalationRequest(request),
    ...extra,
  };
}

/** Evaluate one case against the shipped codec (mirrors wire_ref.evaluate). */
export function evaluateTs(testCase) {
  const op = testCase.op;
  const payload = testCase.payload;
  try {
    if (op === 'build') {
      return tsAccept(buildCourtEscalationRequest(payload));
    }
    if (op === 'parse_text' || op === 'parse_object') {
      return tsAccept(parseCourtEscalationRequest(payload));
    }
    if (op === 'to_event') {
      const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const request = buildCourtEscalationRequest(body.request ?? {});
      const event = escalationRequestToMachineEvent(
        body.state,
        request,
        body.now,
        body.binding,
      );
      return tsAccept(request, { event });
    }
    return { outcome: 'refuse', code: 'panic', detail: `unknown op ${String(op)}` };
  } catch (error) {
    return { outcome: 'refuse', code: classifyTsError(error), detail: String(error && error.message) };
  }
}

// ─── B. the Python reference ─────────────────────────────────────────────────

function pythonBinary() {
  return process.env.BAO_DIFFERENTIAL_PYTHON || 'python3';
}

export function pythonAvailable() {
  const probe = spawnSync(pythonBinary(), ['--version'], { encoding: 'utf8', timeout: 20_000 });
  return probe.status === 0;
}

/** Run the reference over a JSONL case file; returns the JSONL result file path. */
function runReference(casesPath, resultsPath) {
  const run = spawnSync(pythonBinary(), [REFERENCE, '--in', casesPath, '--out', resultsPath], {
    encoding: 'utf8',
    timeout: 600_000,
  });
  if (run.status !== 0) {
    throw new Error(
      `wire_ref.py failed (status ${String(run.status)}): ${run.stderr || run.error || ''}`.trim(),
    );
  }
}

// ─── C. the corpus ───────────────────────────────────────────────────────────

/** mulberry32 — one small PRNG, seeded, identical across runs. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, items) => items[int(rng, 0, items.length - 1)];
const chance = (rng, p) => rng() < p;

const hex = (rng) => Array.from({ length: 64 }, () => '0123456789abcdef'[int(rng, 0, 15)]).join('');

/**
 * Every character whose classification as "edge whitespace" could differ
 * between the ECMAScript set the shipped codec uses (`String.prototype.trim`)
 * and the Unicode `White_Space` set / Python's `str.isspace()` that a second
 * implementer would reach for. Enumerated, not sampled: the disagreement this
 * campaign cares about here is a SET, so the corpus must contain the set.
 */
const EDGE_CHARACTERS = Object.freeze([
  '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u0085',
  '\u00a0', '\u1680', '\u180e', '\u2000', '\u2001', '\u2002', '\u2003',
  '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a',
  '\u200b', '\u200c', '\u200d', '\u2028', '\u2029', '\u202f', '\u205f',
  '\u2060', '\u3000', '\u001c', '\u001d', '\u001e', '\u001f', '\ufeff',
]);

/** Combining marks, bidi controls, astral characters — the encoding boundaries. */
const ID_ATOMS = Object.freeze([
  'court:market-r49:1',
  'court:market-r49:1\u0301', // NFD combining acute
  'caf\u00e9', // NFC
  'cafe\u0301', // NFD
  '\u202eabc', // RTL override
  '\u2066a\u2069', // bidi isolates
  '\ud83d\ude00', // astral (a surrogate PAIR — canonical)
  'court:\u200b:1', // zero-width interior
  '\u8c5a:1', // CJK
  'court:market-r49:2',
]);

function validDescriptor(rng) {
  const request = {
    caseId: pick(rng, ID_ATOMS),
    round: int(rng, 1, 5),
    challengerPubkey: hex(rng),
    bondTxid: hex(rng),
    bondProofHash: hex(rng),
    roundBondProofHash: chance(rng, 0.7) ? hex(rng) : null,
    eventId: hex(rng),
    signedAtSec: int(rng, 0, 2_000_000_000),
    concession: false,
  };
  if (chance(rng, 0.15)) delete request.roundBondProofHash;
  if (chance(rng, 0.2)) delete request.concession;
  return request;
}

/** The canonical wire text, written from the SPEC (never by calling the codec). */
function canonicalWire(request) {
  const order = [
    'caseId', 'round', 'challengerPubkey', 'bondTxid', 'bondProofHash',
    'roundBondProofHash', 'eventId', 'signedAtSec', 'concession',
  ];
  const parts = order.map((field) => {
    const value = field === 'roundBondProofHash' && !(field in request) ? null : request[field];
    return `${JSON.stringify(field)}:${JSON.stringify(value === undefined ? null : value)}`;
  });
  return `{${parts.join(',')}}`;
}

const BAD_HEX = Object.freeze([
  '',
  '0'.repeat(63),
  '0'.repeat(65),
  'A'.repeat(64),
  'g'.repeat(64),
  ' '.repeat(64),
  '0'.repeat(64) + ' ',
  ' ' + '0'.repeat(64),
  null,
  0,
  true,
  ['0'.repeat(64)],
  { hex: '0'.repeat(64) },
]);

const BAD_ROUNDS = Object.freeze([0, 6, -1, 1.5, 5.0000001, null, '1', true, false, [], {}, 2 ** 53, 9e15]);
const BAD_CLOCKS = Object.freeze([-1, -0.5, 0.5, null, '1790000000', true, [], {}, 2 ** 53, -(2 ** 53)]);
const BAD_FLAGS = Object.freeze([null, 'true', 'false', 1, 0, [], {}, '1']);
const NOT_JSON_VALUES = Object.freeze(['', 'x', '{', '[]', 'null', '5', '"str"', 'true', '{}', '{]']);

function validState(rng) {
  const request = validDescriptor(rng);
  request.concession = false;
  const state = {
    phase: 'round_resolved',
    ladderRound: request.round,
    ladder: { round: request.round, voteDeadline: 4000, votes: [], openedAt: 2100 },
    challenges: [
      { idx: int(rng, 1, 5), bondTxid: request.bondTxid, bondProofHash: request.bondProofHash },
    ],
  };
  return { request, state, now: int(rng, 0, 2_000_000_000), binding: {
    caseId: request.caseId,
    authenticatedPubkey: request.challengerPubkey,
  } };
}

/** Deterministic boundary sweep — the cases a random sampler would miss. */
function boundaryCases() {
  const cases = [];
  const push = (op, payload, note) => cases.push({ op, payload, note });

  const base = {
    caseId: 'court:market-r49:1',
    round: 1,
    challengerPubkey: '7'.repeat(64),
    bondTxid: 'd'.repeat(64),
    bondProofHash: 'e'.repeat(64),
    roundBondProofHash: 'a'.repeat(64),
    eventId: '8'.repeat(64),
    signedAtSec: 1_790_000_000,
    concession: false,
  };

  // The whitespace SET, at both edges and alone.
  for (const character of EDGE_CHARACTERS) {
    push('build', { ...base, caseId: character + 'court:x' }, `edge ${character.codePointAt(0).toString(16)}`);
    push('build', { ...base, caseId: 'court:x' + character }, `edge-r ${character.codePointAt(0).toString(16)}`);
    push('build', { ...base, caseId: character }, `alone ${character.codePointAt(0).toString(16)}`);
    push('build', { ...base, caseId: 'a' + character + 'b' }, `interior ${character.codePointAt(0).toString(16)}`);
  }

  // The byte bound at every UTF-8 width: 255 / 256 / 257 bytes.
  for (const [unit, width] of [['x', 1], ['\u00e9', 2], ['\u20ac', 3], ['\ud83d\ude00', 4]]) {
    for (const total of [255, 256, 257]) {
      const filled = unit.repeat(Math.ceil(total / width));
      push('build', { ...base, caseId: filled }, `bytes ${width}x${total}`);
      push('build', { ...base, caseId: 'court:' + filled }, `bytes-prefixed ${width}x${total}`);
    }
  }

  // Surrogates at seven positions — the r8-1 collision family.
  for (const id of ['\ud800', '\udc00', 'a\ud800', '\ud800a', 'a\ud800b', 'a\udc00\ud800b', '\ud83d', '\ude00']) {
    push('build', { ...base, caseId: id }, 'surrogate');
    push('parse_text', canonicalWire({ ...base, caseId: id }), 'surrogate-text');
  }
  // NUL at four positions.
  for (const id of ['\u0000', 'a\u0000', '\u0000a', 'a\u0000b', 'court:\u0000:1']) {
    push('build', { ...base, caseId: id }, 'nul');
  }
  // Empty / whitespace-only shapes and the NFC/NFD pair (no normalisation).
  for (const id of ['', ' ', '\t', '  ', 'x'.repeat(0), '\u3000\u3000', '\u0085\u0085']) {
    push('build', { ...base, caseId: id }, 'empty');
  }
  push('build', { ...base, caseId: 'caf\u00e9' }, 'nfc');
  push('build', { ...base, caseId: 'cafe\u0301' }, 'nfd');

  // Every numeric edge the contract names.
  for (const round of [1, 2, 5]) push('build', { ...base, round }, `round ${round}`);
  for (const round of BAD_ROUNDS) push('build', { ...base, round }, 'bad round');
  for (const clock of [0, 1, 2 ** 53 - 1]) push('build', { ...base, signedAtSec: clock }, `clock ${clock}`);
  for (const clock of BAD_CLOCKS) push('build', { ...base, signedAtSec: clock }, 'bad clock');
  for (const flag of [true, false, undefined]) push('build', { ...base, concession: flag }, `flag ${String(flag)}`);
  for (const flag of BAD_FLAGS) push('build', { ...base, concession: flag }, 'bad flag');

  // Hex shape on every hex field.
  for (const field of ['challengerPubkey', 'bondTxid', 'bondProofHash', 'roundBondProofHash', 'eventId']) {
    for (const bad of BAD_HEX) push('build', { ...base, [field]: bad }, `bad hex ${field}`);
  }
  // The witness slot: absent, null, and the '-' sentinel itself.
  for (const witness of [null, undefined, '-', '-'.repeat(64), 'a'.repeat(64)]) {
    push('build', { ...base, roundBondProofHash: witness }, 'witness slot');
  }
  // Missing required fields (one at a time) and an unknown field.
  for (const field of ['caseId', 'round', 'challengerPubkey', 'bondTxid', 'bondProofHash', 'eventId', 'signedAtSec']) {
    const copy = { ...base };
    delete copy[field];
    push('build', copy, `missing ${field}`);
  }
  push('build', { ...base, extra: 1 }, 'extra field (build ignores it)');
  push('build', null, 'null descriptor');
  push('build', [], 'array descriptor');
  push('build', 'text descriptor', 'string descriptor');
  push('build', 5, 'number descriptor');

  // Parse: canonical text, non-canonical-but-valid text, and every malformed family.
  push('parse_text', canonicalWire(base), 'canonical');
  push('parse_text', JSON.stringify({ ...base, roundBondProofHash: null }), 'canonical-legacy');
  const valid = canonicalWire(base);
  push('parse_text', valid.replace(/,/g, ' , '), 'spaced');
  push('parse_text', valid.replace(/:/g, ' :\n '), 'newlined');
  push('parse_text', '  \t\n' + valid + '\n\t  ', 'surrounded-whitespace');
  push('parse_text', '{"concession":false,"caseId":"court:market-r49:1","round":1,"challengerPubkey":"' + '7'.repeat(64) + '","bondTxid":"' + 'd'.repeat(64) + '","bondProofHash":"' + 'e'.repeat(64) + '","roundBondProofHash":null,"eventId":"' + '8'.repeat(64) + '","signedAtSec":1790000000}', 'reordered');
  push('parse_text', valid.replace('"caseId"', '"c\\u0061seId"'), 'escaped-key');
  push('parse_text', valid.replace('"caseId":', '"caseId":"dup","caseId":'), 'dup-top-level');
  push('parse_text', valid.replace('"round":', '"round":1,"round":'), 'dup-same-value');
  push('parse_text', valid.replace('"caseId":', '"__proto__":1,"caseId":'), 'proto-key');
  push('parse_text', valid.slice(0, -1) + ',"x":1}', 'unknown-field');
  push('parse_text', valid.slice(0, -1) + ',"round_bond_proof_hash":null}', 'snake-case-field');
  push('parse_text', valid.slice(0, -1) + ',"caseId":"other"}', 'dup-caseId-different');
  push('parse_text', '{"caseId":{"a":1,"a":2},"round":1,"challengerPubkey":"' + '7'.repeat(64) + '","bondTxid":"' + 'd'.repeat(64) + '","bondProofHash":"' + 'e'.repeat(64) + '","eventId":"' + '8'.repeat(64) + '","signedAtSec":1}', 'dup-nested-object');
  push('parse_text', '{"caseId":["a","a"],"round":1,"challengerPubkey":"' + '7'.repeat(64) + '","bondTxid":"' + 'd'.repeat(64) + '","bondProofHash":"' + 'e'.repeat(64) + '","eventId":"' + '8'.repeat(64) + '","signedAtSec":1}', 'dup-nested-array');
  push('parse_text', '{"caseId":[{"a":1,"a":2}],"round":1}', 'dup-nested-deep');
  push('parse_text', '{"concession":true,"concession":false,"caseId":"a","round":1,"challengerPubkey":"' + '7'.repeat(64) + '","bondTxid":"' + 'd'.repeat(64) + '","bondProofHash":"' + 'e'.repeat(64) + '","eventId":"' + '8'.repeat(64) + '","signedAtSec":1}', 'dup-concession');
  push('parse_text', '{"caseId":"a\\",\\"concession\\":true,\\"x","round":1,"challengerPubkey":"' + '7'.repeat(64) + '","bondTxid":"' + 'd'.repeat(64) + '","bondProofHash":"' + 'e'.repeat(64) + '","eventId":"' + '8'.repeat(64) + '","signedAtSec":1}', 'scanner-text-trap');
  push('parse_text', '{"caseId":"a\\",\\"b","concession":false,"concession":true,"round":1,"challengerPubkey":"' + '7'.repeat(64) + '","bondTxid":"' + 'd'.repeat(64) + '","bondProofHash":"' + 'e'.repeat(64) + '","eventId":"' + '8'.repeat(64) + '","signedAtSec":1}', 'scanner-text-trap-then-dup');
  push('parse_text', '['.repeat(20000) + ']'.repeat(20000), 'deep-array');
  push('parse_text', '{"caseId":' + '['.repeat(20000) + '1' + ']'.repeat(20000) + '}', 'deep-nested');
  for (const text of NOT_JSON_VALUES) push('parse_text', text, 'not json');
  for (const text of ['NaN', 'Infinity', '-Infinity', '{"round":NaN}', '{"round":1e400}', '{"round":01}', '{"round":1.}', '{"round":.5}', '{"round":+1}', '{"round":-0}', '{"signedAtSec":-0}', '{"round":1e1,"caseId":"a"}', '{"round":9007199254740993}']) {
    push('parse_text', text, 'numeric literal');
  }
  push('parse_text', '\ufeff{"caseId":"a"}', 'bom');
  push('parse_text', '{"caseId":"a"} trailing', 'trailing-garbage');
  push('parse_text', '{"caseId":"a"}{"caseId":"b"}', 'second-value');
  push('parse_text', '{"caseId":"a",}', 'trailing-comma');
  push('parse_text', "'{\"caseId\":\"a\"}'", 'single-quotes');
  push('parse_text', '{"caseId":"a\\ud800"}', 'lone-surrogate-escape');
  push('parse_text', '{"caseId":"a\\\\ud800"}', 'escaped-lone-surrogate');
  push('parse_text', '{"caseId":"a\\u0000b"}', 'nul-escape');
  push('parse_text', '{"caseId":"\\u0085"}', 'nel-only');
  push('parse_text', '{"caseId":"\\ufeff"}', 'feff-only');
  push('parse_text', '{"caseId":"' + 'x'.repeat(257) + '"}', 'long-id');
  push('parse_text', '{"caseId":"' + 'x'.repeat(256) + '"}', 'max-id');
  // parse_object: the duplicate is already gone; the object form must still be strict.
  push('parse_object', Object.fromEntries(Object.entries(base)), 'object');
  push('parse_object', { ...base, roundBondProofHash: null }, 'object-legacy');
  push('parse_object', { ...base, extra: 1 }, 'object-extra');
  push('parse_object', { ...base, caseId: undefined }, 'object-undefined-id');
  push('parse_object', null, 'object-null');
  push('parse_object', [], 'object-array');
  push('parse_object', 'wire text', 'object-string');

  // The wire -> event mapping: the host's half of the contract.
  const eventBase = {
    request: { ...base },
    state: {
      phase: 'round_resolved',
      ladderRound: 1,
      ladder: { round: 1, voteDeadline: 4000, votes: [], openedAt: 2100 },
      challenges: [{ idx: 2, bondTxid: base.bondTxid, bondProofHash: base.bondProofHash }],
    },
    now: 3200,
    binding: { caseId: base.caseId, authenticatedPubkey: base.challengerPubkey },
  };
  push('to_event', eventBase, 'event-ok');
  push('to_event', { ...eventBase, binding: undefined }, 'binding-missing');
  push('to_event', { ...eventBase, binding: null }, 'binding-null');
  push('to_event', { ...eventBase, binding: [] }, 'binding-array');
  push('to_event', { ...eventBase, binding: 'binding' }, 'binding-string');
  push('to_event', { ...eventBase, binding: { ...eventBase.binding, caseId: 'court:other' } }, 'binding-case');
  push('to_event', { ...eventBase, binding: { ...eventBase.binding, caseId: base.caseId + ' ' } }, 'binding-case-folded');
  push('to_event', { ...eventBase, binding: { ...eventBase.binding, authenticatedPubkey: 'f'.repeat(64) } }, 'binding-pubkey');
  push('to_event', { ...eventBase, binding: { ...eventBase.binding, authenticatedPubkey: 'A'.repeat(64) } }, 'binding-pubkey-upper');
  push('to_event', { ...eventBase, binding: { caseId: base.caseId } }, 'binding-no-pubkey');
  push('to_event', { ...eventBase, request: { ...base, concession: true } }, 'concession-as-escalation');
  push('to_event', { ...eventBase, request: { ...base, round: 2 } }, 'round-mismatch');
  push('to_event', { ...eventBase, request: { ...base, bondTxid: 'b'.repeat(64) } }, 'bond-txid-mismatch');
  push('to_event', { ...eventBase, request: { ...base, bondProofHash: 'b'.repeat(64) } }, 'bond-unknown');
  push('to_event', { ...eventBase, state: { ...eventBase.state, ladderRound: 2 } }, 'ladder-round-skew');
  push('to_event', { ...eventBase, state: { ...eventBase.state, ladder: undefined } }, 'ladder-absent');
  push('to_event', { ...eventBase, state: { ...eventBase.state, ladder: null } }, 'ladder-null');
  push('to_event', { ...eventBase, state: { ...eventBase.state, ladder: [] } }, 'ladder-array');
  push('to_event', { ...eventBase, state: { ...eventBase.state, ladder: { round: 2 } } }, 'ladder-counters');
  push('to_event', { ...eventBase, state: { ...eventBase.state, ladder: { round: '1' } } }, 'ladder-counters-string');
  // v0.15.3 — the G-4 lane projection (the r12-1 over-strictness fix): a DECLARED
  // counter with no in-state ladder is the host's persisted shape and the mapper
  // must mint from it; the same shape WITHOUT the marker still refuses.
  const laneBase = {
    phase: 'round_resolved',
    projection: 'lane',
    ladderRound: 1,
    challenges: [{ idx: 2, bondTxid: base.bondTxid, bondProofHash: base.bondProofHash }],
  };
  push('to_event', { ...eventBase, state: laneBase }, 'lane-projection');
  push('to_event', { ...eventBase, state: { ...laneBase, ladderRound: 2, }, request: { ...base, round: 2 } }, 'lane-projection-round2');
  push('to_event', { ...eventBase, state: { ...eventBase.state, projection: 'lane' } }, 'lane-projection-with-ladder');
  push('to_event', { ...eventBase, state: { ...laneBase, ladderRound: '1' } }, 'lane-projection-counter-string');
  push('to_event', { ...eventBase, state: { ...laneBase, ladderRound: 2.5 } }, 'lane-projection-counter-float');
  push('to_event', { ...eventBase, state: { ...laneBase, projection: 'wallet' } }, 'unknown-projection-missing-ladder');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: [] } }, 'no-bond');
  push('to_event', {
    ...eventBase,
    state: {
      ...eventBase.state,
      challenges: [
        { idx: 2, bondTxid: base.bondTxid, bondProofHash: base.bondProofHash },
        { idx: 3, bondTxid: 'b'.repeat(64), bondProofHash: base.bondProofHash },
      ],
    },
  }, 'ambiguous-bond');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: {} } }, 'challenges-object');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: null } }, 'challenges-null');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: 'rows' } }, 'challenges-string');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: [null] } }, 'challenges-null-row');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: ['row'] } }, 'challenges-string-row');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: [42] } }, 'challenges-number-row');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: true } }, 'challenges-bool');
  push('to_event', { ...eventBase, state: { ...eventBase.state, challenges: [] }, request: { ...base, concession: true } }, 'precedence-concession-vs-bond');
  push('to_event', { ...eventBase, state: undefined }, 'state-absent');
  push('to_event', { ...eventBase, state: null }, 'state-null');
  for (const now of [0, 1, 2 ** 53 - 1, -1, 1.5, null, '3200', true, [], 2 ** 53]) {
    push('to_event', { ...eventBase, now }, `now ${String(now)}`);
  }
  push('to_event', { ...eventBase, request: { ...base, roundBondProofHash: null } }, 'legacy-witness');
  push('to_event', { ...eventBase, request: { ...base, round: 5 }, state: { ...eventBase.state, ladderRound: 5, ladder: { round: 5 } } }, 'top-round');

  return cases;
}

/** Random cases — mutations of valid shapes, so a refusal is never trivially reached. */
function randomCase(rng) {
  const kind = rng();
  if (kind < 0.35) return randomBuildCase(rng);
  if (kind < 0.60) return randomParseCase(rng, 'parse_text');
  if (kind < 0.70) return randomParseCase(rng, 'parse_object');
  return randomEventCase(rng);
}

function randomBuildCase(rng) {
  let request = validDescriptor(rng);
  const roll = rng();
  if (roll < 0.45) {
    // mutually valid
  } else if (roll < 0.6) {
    request = { ...request, caseId: mutateId(rng, request.caseId) };
  } else if (roll < 0.7) {
    const field = pick(rng, ['challengerPubkey', 'bondTxid', 'bondProofHash', 'roundBondProofHash', 'eventId']);
    request = { ...request, [field]: pick(rng, BAD_HEX) };
  } else if (roll < 0.78) {
    request = { ...request, round: pick(rng, BAD_ROUNDS) };
  } else if (roll < 0.85) {
    request = { ...request, signedAtSec: pick(rng, BAD_CLOCKS) };
  } else if (roll < 0.9) {
    request = { ...request, concession: pick(rng, BAD_FLAGS) };
  } else {
    const field = pick(rng, ['caseId', 'round', 'challengerPubkey', 'bondTxid', 'bondProofHash', 'eventId', 'signedAtSec']);
    delete request[field];
  }
  return { op: 'build', payload: request };
}

function mutateId(rng, id) {
  const roll = rng();
  if (roll < 0.25) return pick(rng, EDGE_CHARACTERS) + id;
  if (roll < 0.5) return id + pick(rng, EDGE_CHARACTERS);
  if (roll < 0.6) return id.slice(0, 2) + '\u0000' + id.slice(2);
  if (roll < 0.7) return id.slice(0, 2) + '\ud800' + id.slice(2);
  if (roll < 0.8) return id + 'x'.repeat(int(rng, 240, 260));
  if (roll < 0.9) return '';
  return pick(rng, EDGE_CHARACTERS);
}

function randomParseCase(rng, op) {
  const request = validDescriptor(rng);
  const text = canonicalWire(request);
  const roll = rng();
  let payload;
  if (op === 'parse_object') {
    if (roll < 0.5) payload = { ...request };
    else if (roll < 0.65) payload = { ...request, [pick(rng, ['x', '__proto__', 'round_bond_proof_hash'])]: 1 };
    else if (roll < 0.8) {
      const copy = { ...request };
      delete copy[pick(rng, Object.keys(copy))];
      payload = copy;
    } else payload = { ...request, [pick(rng, Object.keys(request))]: pick(rng, [null, 0, true, [], {}, 'x']) };
    return { op, payload };
  }
  if (roll < 0.4) payload = text;
  else if (roll < 0.5) payload = text.replace(/,/g, pick(rng, [', ', ' ,', ',\n', ',\t']));
  else if (roll < 0.6) payload = text.slice(0, -1) + ',"' + 'x' + '":' + JSON.stringify(pick(rng, [1, null, 'y'])) + '}';
  else if (roll < 0.7) {
    const field = pick(rng, ['caseId', 'round', 'concession', 'eventId', 'roundBondProofHash']);
    payload = text.replace(`"${field}":`, `"${field}":${JSON.stringify(pick(rng, [null, 0, 'x', true, [1, 2]]))},"${field}":`);
  } else if (roll < 0.8) payload = text.replace('"caseId":', '"c\\u0061seId":');
  else if (roll < 0.9) payload = text.replace('"caseId":', `"caseId":${JSON.stringify(mutateId(rng, request.caseId))},"caseId":`);
  else payload = pick(rng, NOT_JSON_VALUES.concat(['{"round":9007199254740993}', '{"round":-0}', '{"signedAtSec":1e400}']));
  return { op, payload };
}

function randomEventCase(rng) {
  const { request, state, now, binding } = validState(rng);
  const copy = {
    request: { ...request },
    state: { ...state, ladder: { ...state.ladder }, challenges: state.challenges.map((row) => ({ ...row })) },
    now,
    binding: { ...binding },
  };
  const roll = rng();
  if (roll < 0.55) {
    // valid (with occasional legitimate variations)
    if (chance(rng, 0.3)) copy.request.roundBondProofHash = chance(rng, 0.5) ? null : hex(rng);
    if (chance(rng, 0.2)) delete copy.request.concession;
  } else if (roll < 0.65) {
    copy.request.concession = chance(rng, 0.5) ? true : pick(rng, BAD_FLAGS.filter((flag) => flag !== true));
  } else if (roll < 0.75) {
    copy.binding = chance(rng, 0.3) ? undefined : { ...copy.binding, [pick(rng, ['caseId', 'authenticatedPubkey'])]: pick(rng, ['court:other', 'A'.repeat(64), hex(rng), '', null, 5]) };
  } else if (roll < 0.85) {
    const field = pick(rng, ['ladderRound', 'ladder', 'challenges']);
    if (field === 'ladderRound') copy.state.ladderRound = int(rng, 0, 6);
    else if (field === 'ladder') copy.state.ladder = pick(rng, [undefined, null, [], { round: int(rng, 0, 6) }, 'ladder']);
    else copy.state.challenges = pick(rng, [
      [], null, {}, 'rows', true,
      [null], ['row'], [42],
      [{ ...copy.state.challenges[0], bondTxid: 'b'.repeat(64) }],
      [copy.state.challenges[0], { ...copy.state.challenges[0], idx: 9 }],
      [{ idx: 2, bondTxid: copy.state.challenges[0].bondTxid }],
    ]);
  } else if (roll < 0.92) {
    copy.now = pick(rng, [-1, 1.5, null, '3200', true, [], 2 ** 53, 0]);
  } else {
    copy.request = { ...copy.request, [pick(rng, ['caseId', 'challengerPubkey', 'bondTxid', 'bondProofHash', 'round'])]: pick(rng, ['court:other', 'A'.repeat(64), 'x', null, 0, 6, '1']) };
  }
  return { op: 'to_event', payload: copy };
}

/** Stream the corpus into `casesPath`; returns the per-op counts. */
function writeCorpus(casesPath, count, seed) {
  const fd = openSync(casesPath, 'w');
  const ops = { build: 0, parse_text: 0, parse_object: 0, to_event: 0 };
  let written = 0;
  const emit = (testCase) => {
    const record = { id: `c${String(written).padStart(6, '0')}`, op: testCase.op, payload: testCase.payload };
    if (testCase.note !== undefined) record.note = testCase.note;
    writeSync(fd, JSON.stringify(record) + '\n');
    ops[testCase.op] += 1;
    written += 1;
  };
  const sweep = boundaryCases();
  for (const testCase of sweep) {
    if (written >= count) break;
    emit(testCase);
  }
  const rng = mulberry32(seed);
  while (written < count) emit(randomCase(rng));
  closeSync(fd);
  return { ops, written, sweep: Math.min(sweep.length, count) };
}

// ─── D. compare ──────────────────────────────────────────────────────────────

/**
 * The comparison. `signature` is what a disagreement IS — (ts side, py side) on
 * the axes that must agree; two cases with the same signature are the same
 * finding and shrink to the same minimal input.
 */
function compareRecords(testCase, ts, py) {
  const problems = [];
  if (ts.outcome !== py.outcome) problems.push('outcome');
  if (ts.outcome === 'refuse' && py.outcome === 'refuse' && ts.code !== py.code) problems.push('class');
  if (ts.outcome === 'accept' && py.outcome === 'accept') {
    if (ts.preimage !== py.preimage) problems.push('preimage');
    if (ts.digest !== py.digest) problems.push('digest');
    if (ts.serialized !== py.serialized) problems.push('serialized');
    if (canonString(ts.event ?? null) !== canonString(py.event ?? null)) problems.push('event');
  }
  if (problems.length === 0) return null;
  return {
    signature: [
      testCase.op,
      problems.join('+'),
      ts.outcome === 'accept' ? 'accept' : ts.code,
      py.outcome === 'accept' ? 'accept' : py.code,
    ].join('|'),
    problems,
    ts: { outcome: ts.outcome, code: ts.code, digest: ts.digest, detail: ts.detail },
    py: { outcome: py.outcome, code: py.code, digest: py.digest, detail: py.detail },
  };
}

function caseDisagrees(testCase) {
  const ts = evaluateTs(testCase);
  const py = evaluateOnePython(testCase);
  const disagreement = compareRecords(testCase, ts, py);
  return { disagreement, ts, py };
}

/** Evaluate ONE case with the reference (used by the shrinker). */
function evaluateOnePython(testCase) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wire-ref-'));
  try {
    const casesPath = path.join(dir, 'cases.jsonl');
    const resultsPath = path.join(dir, 'results.jsonl');
    writeFileSync(casesPath, JSON.stringify({ id: 'single', op: testCase.op, payload: testCase.payload }) + '\n');
    runReference(casesPath, resultsPath);
    const line = readFileSync(resultsPath, 'utf8').trim();
    const parsed = JSON.parse(line);
    delete parsed.id;
    return parsed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Shrink a disagreeing case to a minimal repro: greedily drop object keys,
 * shorten strings and neutralise numbers while the SAME signature keeps
 * disagreeing. Every candidate is re-run through BOTH implementations.
 */
function shrink(testCase, signature, budget = 40) {
  let best = testCase;
  for (let round = 0; round < budget; round += 1) {
    const candidates = shrinkCandidates(best);
    let improved = false;
    for (const candidate of candidates) {
      let verdict;
      try {
        verdict = caseDisagrees(candidate);
      } catch {
        continue;
      }
      if (verdict.disagreement !== null && verdict.disagreement.signature === signature) {
        best = candidate;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return best;
}

function shrinkCandidates(testCase) {
  const candidates = [];
  const payload = testCase.payload;
  const push = (next) => candidates.push({ op: testCase.op, payload: next });

  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const key of Object.keys(payload)) {
      const copy = { ...payload };
      delete copy[key];
      push(copy);
    }
    for (const key of Object.keys(payload)) {
      const value = payload[key];
      if (typeof value === 'string' && value.length > 8) push({ ...payload, [key]: value.slice(0, 8) });
      else if (typeof value === 'number' && value !== 1) push({ ...payload, [key]: 1 });
      else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const inner of Object.keys(value)) {
          const copy = { ...value };
          delete copy[inner];
          push({ ...payload, [key]: copy });
        }
        if (Array.isArray(value.challenges)) {
          for (let index = 0; index < value.challenges.length; index += 1) {
            push({ ...payload, [key]: { ...value, challenges: value.challenges.filter((_, i) => i !== index) } });
          }
        }
      }
    }
  } else if (typeof payload === 'string' && payload.length > 4) {
    push(payload.slice(0, Math.floor(payload.length / 2)));
    push(payload.replace(/\s+/g, ''));
  }
  return candidates;
}

// ─── E. outcomes worth recording (the closed table this campaign must state) ──

/**
 * The findings this harness produced when it was first run against v0.14.2,
 * each with the resolution it got. They are recorded in the committed summary
 * so the campaign's honesty survives the fixes: a re-run cannot "rediscover"
 * them by construction (they are closed), so the record is the proof they
 * existed. `verdict` is which side was wrong — 'ts-bug', 'reference-bug' or
 * 'spec-gap' (both sides pinned). Full text: docs/DIFFERENTIAL_WIRE.md.
 */
export const FINDING_REGISTER = Object.freeze([
  {
    id: 'd1',
    verdict: 'ts-bug',
    summary:
      'escalationRequestToMachineEvent threw a RAW TypeError on a restored snapshot: `state.ladderRound` was read before any shape check (state null -> "Cannot read properties of null (reading \'ladderRound\')"), `state.challenges.filter` on a non-array ledger ("... is not a function", 344 cases) and a null ledger row ("Cannot read properties of null (reading \'bondProofHash\')", 95 cases). Every other guard in the package fails closed with a typed error (assertStateArrays, r3-1/r41-1); this path did not.',
    resolution:
      'Fixed in courtEscalationRequest.ts: the mapper now requires a record state, an array challenge ledger, and matches only rows that are objects — all typed refusals. Pinned in __tests__/differentialWire.test.ts.',
    repro: { op: 'to_event', note: 'state null; challenges {} / null / [null]' },
  },
  {
    id: 'd2',
    verdict: 'ts-bug',
    summary:
      'A NON-OBJECT descriptor escaped the codec as a raw TypeError: build(null) -> "Cannot read properties of null (reading \'caseId\')". The r8-5 hardening ("a raw TypeError must not escape instead of this module\'s typed refusal") covered re-read fields but not the argument itself, and hash/build/escalationRequestToMachineEvent all reach it.',
    resolution:
      'Fixed: buildCourtEscalationRequest refuses a non-object descriptor with the typed refusal the wire uses for a non-object body (class not_object). Pinned in __tests__/differentialWire.test.ts (build(null), build([]), hash(null)).',
    repro: { op: 'build', note: 'payload null / [] / "text"' },
  },
  {
    id: 'd3',
    verdict: 'spec-gap',
    summary:
      '"must not have leading or trailing whitespace" never said WHICH characters. The ECMAScript trim set (the shipped reading) REFUSES U+FEFF at an edge but ACCEPTS U+0085 and U+001C..U+001F, which Unicode White_Space (and Python str.isspace) treat as whitespace: a second implementer picking the Unicode set disagrees in both directions, on invisible characters, at the one place two ids must not become one.',
    resolution:
      'Decision: the ECMAScript WhiteSpace+LineTerminator set IS the contract (the codec is the JS library and trim is its definition). Pinned in the reference (JS_WHITESPACE) and in the differential test over the union of both sets (35 characters, both edges, alone, interior). docs/DIFFERENTIAL_WIRE.md §5 D1.',
    repro: { op: 'build', note: 'caseId prefixed/suffixed with U+0085 (accepted) or U+FEFF (refused)' },
  },
  {
    id: 'd4',
    verdict: 'spec-gap',
    summary:
      'The "canonical UTF-8 (no unpaired surrogates)" refusal is not the test its message names: it is a TextEncoder/TextDecoder round-trip, and a WHATWG decoder STRIPS one leading U+FEFF, so any id beginning with a BOM is refused as "surrogates" instead of as edge whitespace. Measured on the first run: leading-BOM id -> case_id_not_canonical while the same BOM at the end -> case_id_whitespace, and a BOM-only id -> "non-empty string". Two readings of the sentence report different reasons for the same refusal.',
    resolution:
      'Decision: the ROUND-TRIP is the contract (it is the injectivity test that matters, and both readings refuse the string), so the reference models the BOM strip explicitly. Registered as a diagnostic wart: the message names a surrogate that is not there, which sends an operator hunting the wrong character. Fixing the wording (or ignoreBOM) changes ballot-outcome validation in courtVoteMachine, a different module — out of scope, registered for the owner. Pinned in docs/DIFFERENTIAL_WIRE.md §5 D4 and in the test (leading vs trailing BOM classes).',
    repro: { op: 'build', note: 'caseId "\\ufeffcourt:x" (class: not canonical) vs "court:x\\ufeff" (class: whitespace)' },
  },
  {
    id: 'd5',
    verdict: 'spec-gap',
    summary:
      'A JSON numeric literal is not a value. `9007199254740991.4` is read by a double parser as the integer 9007199254740991 (a safe integer, so the request is ACCEPTED and digested as that) and by an exact/decimal parser as a non-integer (REFUSED); `9007199254740993` is refused by both but for different reasons (double: 2^53 is outside the safe range; exact: ...993 is). The wire had no sentence about numeric portability, so two implementations can differ on accept/refuse for the fractional class. Modelled from the start in the reference, so the campaign never recorded it as a disagreement — a corner closed by decision, not a bug found.',
    resolution:
      'Decision: a number field is the IEEE-754 double its literal denotes (JSON.parse semantics). Encoders must emit decimal integers in +/-(2^53-1); a fractional literal that rounds to a safe integer is accepted with the rounded value, and the canonical re-serialization carries the double. Pinned in the reference (parse_int=float) and in the test. docs/DIFFERENTIAL_WIRE.md §5 D3.',
    repro: { op: 'parse_text', note: '{"signedAtSec":9007199254740991.4} accepted as ...991; {"signedAtSec":9007199254740993} refused' },
  },
]);

// ─── F. main ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { count: 100_000, seed: 20_261_111, out: path.join(HERE, 'results', 'r49-100k.json'), only: false, allowMissingPython: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--only') {
      options.only = true;
      const next = argv[index + 1];
      options.count = next !== undefined && /^\d+$/.test(next) ? Number(next) : 2_000;
      if (next !== undefined && /^\d+$/.test(next)) index += 1;
    } else if (arg === '--count') {
      options.count = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--seed') {
      options.seed = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--out') {
      options.out = argv[index + 1];
      index += 1;
    } else if (arg === '--allow-missing-python') {
      options.allowMissingPython = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: npx tsx scripts/differential/run.mjs [--only [N]] [--count N] [--seed N] [--out FILE]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error('--count must be a positive integer');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!pythonAvailable()) {
    if (options.allowMissingPython) {
      console.log('SKIP: python3 not available — the differential cannot run');
      return;
    }
    throw new Error('python3 is required for the differential (set BAO_DIFFERENTIAL_PYTHON to override)');
  }

  const workdir = mkdtempSync(path.join(tmpdir(), 'bao-wire-differential-'));
  const casesPath = path.join(workdir, 'cases.jsonl');
  const resultsPath = path.join(workdir, 'results.jsonl');
  const startedAt = Date.now();
  try {
    const corpus = writeCorpus(casesPath, options.count, options.seed);
    runReference(casesPath, resultsPath);

    const counters = {
      cases: 0,
      accept: 0,
      refuse: 0,
      byOp: { build: 0, parse_text: 0, parse_object: 0, to_event: 0 },
      byClass: Object.fromEntries(REFUSAL_CLASSES.map((name) => [name, 0])),
      byClassAccept: 0,
    };
    const disagreements = new Map();

    const caseReader = readline.createInterface({ input: createReadStream(casesPath, 'utf8'), crlfDelay: Infinity });
    const resultReader = readline.createInterface({ input: createReadStream(resultsPath, 'utf8'), crlfDelay: Infinity });
    const caseIterator = caseReader[Symbol.asyncIterator]();
    const resultIterator = resultReader[Symbol.asyncIterator]();

    for (;;) {
      const nextCase = await caseIterator.next();
      if (nextCase.done) break;
      if (nextCase.value.trim() === '') continue;
      const nextResult = await resultIterator.next();
      if (nextResult.done) throw new Error('the reference produced fewer results than cases');
      const testCase = JSON.parse(nextCase.value);
      const py = JSON.parse(nextResult.value);
      const ts = evaluateTs(testCase);

      counters.cases += 1;
      counters.byOp[testCase.op] = (counters.byOp[testCase.op] ?? 0) + 1;
      if (ts.outcome === 'accept') {
        counters.accept += 1;
        counters.byClassAccept += 1;
      } else {
        counters.refuse += 1;
        counters.byClass[ts.code] = (counters.byClass[ts.code] ?? 0) + 1;
      }

      const mismatch = compareRecords(testCase, ts, py);
      if (mismatch !== null) {
        const existing = disagreements.get(mismatch.signature);
        if (existing === undefined) {
          disagreements.set(mismatch.signature, {
            signature: mismatch.signature,
            problems: mismatch.problems,
            cases: 1,
            firstCaseId: testCase.id,
            note: testCase.note ?? null,
            example: { op: testCase.op, payload: testCase.payload },
            ts: mismatch.ts,
            py: mismatch.py,
          });
        } else {
          existing.cases += 1;
        }
      }
    }
    caseReader.close();
    resultReader.close();

    // Shrink each distinct disagreement to a minimal repro.
    const records = [];
    for (const entry of disagreements.values()) {
      let minimal = entry.example;
      if (!options.only && entry.ts.code !== 'panic') {
        const shrunk = shrink(entry.example, entry.signature);
        minimal = { op: shrunk.op, payload: shrunk.payload };
      }
      records.push({ ...entry, minimalRepro: minimal });
    }

    const durationMs = Date.now() - startedAt;
    const summary = {
      campaign: 'r49-differential-wire',
      package: '@bao/court',
      shippedImplementation: 'courtEscalationRequest.ts',
      referenceImplementation: 'scripts/differential/wire_ref.py (python3, stdlib only)',
      seed: options.seed,
      cases: counters.cases,
      sweepCases: corpus.sweep,
      durationMs,
      ops: counters.byOp,
      outcomes: { accept: counters.accept, refuse: counters.refuse },
      refusalClasses: counters.byClass,
      distinctDisagreements: records.length,
      disagreements: records,
      findingRegister: FINDING_REGISTER,
      command: `npx tsx scripts/differential/run.mjs --count ${options.count} --seed ${options.seed}`,
    };

    if (!options.only) {
      mkdirSync(path.dirname(options.out), { recursive: true });
      writeFileSync(options.out, JSON.stringify(summary, null, 2) + '\n');
      console.log(`wrote ${options.out}`);
    }

    const tail = [
      `cases=${counters.cases}`,
      `accept=${counters.accept}`,
      `refuse=${counters.refuse}`,
      `disagreements=${records.length}`,
      `${(durationMs / 1000).toFixed(1)}s`,
    ].join(' ');
    console.log(tail);
    if (records.length > 0) {
      for (const record of records) {
        console.log(`\nDISAGREEMENT ${record.signature} (${record.cases} case(s), first ${record.firstCaseId})`);
        console.log(`  ts: ${JSON.stringify(record.ts)}`);
        console.log(`  py: ${JSON.stringify(record.py)}`);
        console.log(`  minimal repro: ${JSON.stringify(record.minimalRepro)}`);
      }
      process.exitCode = 1;
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
