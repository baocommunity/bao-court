// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * DIFFERENTIAL WIRE — round 49.
 *
 * The escalation request codec (`courtEscalationRequest.ts`) has a fast
 * differential partner: `scripts/differential/wire_ref.py`, an independent
 * Python 3 implementation written from the prose, and
 * `scripts/differential/run.mjs`, which drives both over a seeded corpus and
 * compares accept/refuse, the refusal CLASS, the preimage bytes, the digest,
 * the canonical wire string and the mapped `escalate` event.
 *
 * This file runs the harness in its fast mode (`--only`, 2 000 cases including
 * the whole deterministic boundary sweep) so the parity claim is checked by
 * `npm test`, in a few seconds. The 100 000-case campaign is a deliberate,
 * committed artifact (`scripts/differential/results/r49-100k.json`), not a
 * suite member: its runtime is ~30 s and its output is compared, not asserted.
 *
 * It also pins the four corners the differential forced a DECISION on, in
 * process and without Python, so they stay decided even where the reference is
 * unavailable (docs/DIFFERENTIAL_WIRE.md §5):
 *
 *   D1  "leading/trailing whitespace" is the ECMAScript trim set — U+0085 and
 *       U+001C..U+001F are id CHARACTERS, U+FEFF is whitespace;
 *   D2  a tampered snapshot is a TYPED refusal, never a raw TypeError;
 *   D3  a number field is the IEEE-754 double its literal denotes;
 *   D4  canonicality is a round-trip (a leading U+FEFF is stripped -> refused
 *       as not canonical, a trailing one as whitespace).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { wd } from './helpers/watchdog';

import {
  COURT_ESCALATION_REQUEST_DOMAIN,
  buildCourtEscalationRequest,
  escalationRequestToMachineEvent,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
} from '../courtEscalationRequest';
import { CourtConfirmationTransitionError } from '../courtConfirmationMachine';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const RUNNER = path.join(REPO, 'scripts', 'differential', 'run.mjs');
const REFERENCE = path.join(REPO, 'scripts', 'differential', 'wire_ref.py');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

function pythonAvailable(): boolean {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: wd(20_000) });
  return probe.status === 0;
}

const HAS_PYTHON = pythonAvailable();
const HAS_TSX = existsSync(TSX);

const BASE = {
  caseId: 'court:market-r49:1',
  round: 1,
  challengerPubkey: '7'.repeat(64),
  bondTxid: 'd'.repeat(64),
  bondProofHash: 'e'.repeat(64),
  roundBondProofHash: 'a'.repeat(64),
  eventId: '8'.repeat(64),
  signedAtSec: 1_790_000_000,
  concession: false,
} as const;

/** Assert a refusal is the codec's TYPED refusal and match its class by text. */
function refusal(run: () => unknown): CourtConfirmationTransitionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtConfirmationTransitionError);
    const typed = error as CourtConfirmationTransitionError;
    expect(typed.code).toBe('CONFIRMATION_TRANSITION');
    return typed;
  }
  throw new Error('expected a refusal, got acceptance');
}

/** The ECMAScript WhiteSpace ∪ LineTerminator set — DECISION D1. */
const JS_WHITESPACE = [
  '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0',
  '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
  '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029',
  '\u202f', '\u205f', '\u3000', '\ufeff',
];

/**
 * Characters Unicode `White_Space` (and Python's `str.isspace()`) treat as
 * whitespace but ECMAScript does NOT. A second implementer reaching for the
 * Unicode property disagrees with the shipped codec on exactly these — the
 * differential's D1 (docs/DIFFERENTIAL_WIRE.md §5).
 */
const UNICODE_ONLY_WHITESPACE = ['\u0085', '\u001c', '\u001d', '\u001e', '\u001f'];

describe('(r49) the reference implementation reproduces the shared known answer', () => {
  it.skipIf(!HAS_PYTHON)('wire_ref.py --selftest is green (KAT digest, sentinel, class table)', () => {
    const run = spawnSync('python3', [REFERENCE, '--selftest'], { encoding: 'utf8', timeout: wd(60_000) });
    expect(run.stdout).toContain('selftest: OK');
    expect(run.status).toBe(0);
  });

  it.skipIf(!HAS_PYTHON)('the reference is stdlib-only', () => {
    const run = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, "scripts/differential"); import wire_ref; print(wire_ref.DOMAIN)'], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: wd(30_000),
    });
    expect(run.stdout.trim()).toBe('BAO-Court/Escalation/Request/v2');
    expect(run.stderr).toBe('');
  });
});

describe('(r49) the differential harness agrees over the fast corpus', () => {
  it.skipIf(!HAS_PYTHON || !HAS_TSX)(
    'run.mjs --only: 2 000 cases, every boundary sweep, zero disagreements',
    () => {
      const run = spawnSync(TSX, [RUNNER, '--only'], { encoding: 'utf8', timeout: wd(300_000), cwd: REPO });
      const output = `${run.stdout}\n${run.stderr}`;
      // A disagreement makes the harness exit non-zero AND print the repro.
      expect(output).toContain('disagreements=0');
      expect(run.status).toBe(0);
      const summary = /cases=(\d+) accept=(\d+) refuse=(\d+) disagreements=(\d+)/.exec(output);
      expect(summary).not.toBeNull();
      const [, cases, accept, refuse] = summary as RegExpExecArray;
      expect(Number(cases)).toBeGreaterThanOrEqual(2_000);
      // Both outcomes must be exercised, or "agreement" means nothing.
      expect(Number(accept)).toBeGreaterThan(500);
      expect(Number(refuse)).toBeGreaterThan(500);
    },
    wd(300_000),
  );

  it.skipIf(!HAS_PYTHON)('the committed 100k campaign artifact is consistent with its own register', () => {
    const summary = JSON.parse(
      readFileSync(path.join(REPO, 'scripts', 'differential', 'results', 'r49-100k.json'), 'utf8'),
    ) as {
      cases: number;
      distinctDisagreements: number;
      disagreements: unknown[];
      findingRegister: Array<{ id: string; verdict: string }>;
      command: string;
    };
    expect(summary.cases).toBe(100_000);
    expect(summary.distinctDisagreements).toBe(0);
    expect(summary.disagreements).toEqual([]);
    expect(summary.findingRegister.map((entry) => entry.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(summary.command).toContain('scripts/differential/run.mjs');
  });
});

describe('(r49 D1) "leading or trailing whitespace" is the ECMAScript set, pinned', () => {
  it('every ECMAScript whitespace character at either edge is refused', () => {
    for (const character of JS_WHITESPACE) {
      for (const caseId of [character + 'court:x', 'court:x' + character, character]) {
        const error = refusal(() => buildCourtEscalationRequest({ ...BASE, caseId }));
        // A LEADING U+FEFF is refused by the canonicality round-trip (D4), every
        // other edge case by the whitespace rule: two classes, one decision.
        expect(error.message).toMatch(/leading or trailing whitespace|canonical UTF-8|non-empty string/);
      }
    }
  });

  it('Unicode-only whitespace is an id CHARACTER — a second implementer would disagree here', () => {
    for (const character of UNICODE_ONLY_WHITESPACE) {
      // Unicode White_Space / str.isspace() says these are whitespace; the
      // shipped codec says they are id characters, so the ids stay distinct and
      // the digests stay distinct. This is the pinned reading (D1), not an
      // accident: the codec is the JS library and `trim` is its definition.
      expect(() => buildCourtEscalationRequest({ ...BASE, caseId: character + 'court:x' })).not.toThrow();
      expect(() => buildCourtEscalationRequest({ ...BASE, caseId: 'court:x' + character })).not.toThrow();
    }
  });

  it('no folding and no normalisation: edge characters are part of the digest', () => {
    const plain = hashCourtEscalationRequest(buildCourtEscalationRequest({ ...BASE, caseId: 'court:x' }));
    const nel = hashCourtEscalationRequest(buildCourtEscalationRequest({ ...BASE, caseId: '\u0085court:x' }));
    expect(nel).not.toBe(plain);
    const nfc = hashCourtEscalationRequest(buildCourtEscalationRequest({ ...BASE, caseId: 'caf\u00e9' }));
    const nfd = hashCourtEscalationRequest(buildCourtEscalationRequest({ ...BASE, caseId: 'cafe\u0301' }));
    expect(nfc).not.toBe(nfd);
  });

  it('the doc states the set, so a host in any language can implement it', () => {
    const text = readFileSync(path.join(REPO, 'docs', 'DIFFERENTIAL_WIRE.md'), 'utf8');
    expect(text).toMatch(/U\+FEFF/);
    expect(text).toMatch(/U\+0085/);
    expect(text).toMatch(/WhiteSpace/);
    expect(text).toMatch(/scripts\/differential\/wire_ref\.py/);
  });
});

describe('(r49 D2) a tampered snapshot is a typed refusal, never a raw TypeError', () => {
  const state = {
    phase: 'round_resolved',
    ladderRound: 1,
    ladder: { round: 1 },
    challenges: [{ idx: 2, bondTxid: BASE.bondTxid, bondProofHash: BASE.bondProofHash }],
  } as unknown as Parameters<typeof escalationRequestToMachineEvent>[0];
  const binding = { caseId: BASE.caseId, authenticatedPubkey: BASE.challengerPubkey };
  const request = buildCourtEscalationRequest({ ...BASE });

  it('a null/non-object state, as restored from disk', () => {
    for (const broken of [null, undefined, 5, 'state', []]) {
      const error = refusal(() =>
        escalationRequestToMachineEvent(broken as unknown as typeof state, request, 3200, binding),
      );
      expect(error.message).toMatch(/snapshot that is not an object/);
    }
  });

  it('a challenge ledger that is not an array', () => {
    for (const broken of [{}, null, 'rows', true, 5]) {
      const error = refusal(() =>
        escalationRequestToMachineEvent({ ...state, challenges: broken } as unknown as typeof state, request, 3200, binding),
      );
      expect(error.message).toMatch(/no challenge ledger/);
    }
  });

  it('a null row in the ledger is skipped, not dereferenced', () => {
    // A non-object row carries no witness, so it cannot match: the search
    // continues to the typed `no accepted challenge bond` refusal (the
    // reducer's own ledger validation still owns "this ledger is malformed").
    const error = refusal(() =>
      escalationRequestToMachineEvent(
        { ...state, challenges: [null, 'row', 7] } as unknown as typeof state,
        request,
        3200,
        binding,
      ),
    );
    expect(error.message).toMatch(/no accepted challenge bond/);
    // …and with the real row among them, the null row is simply not a bond.
    const event = escalationRequestToMachineEvent(
      { ...state, challenges: [null, state.challenges[0]] } as unknown as typeof state,
      request,
      3200,
      binding,
    );
    expect(event.challengerIdx).toBe(2);
  });

  it('a non-object descriptor is refused by every entry point of the codec', () => {
    for (const broken of [null, undefined, [], 5, 'request']) {
      const build = refusal(() => buildCourtEscalationRequest(broken as never));
      expect(build.message).toMatch(/escalation request must be an object/);
      expect(() => hashCourtEscalationRequest(broken as never)).toThrow(CourtConfirmationTransitionError);
      expect(() => serializeCourtEscalationRequest(broken as never)).toThrow(CourtConfirmationTransitionError);
      expect(() =>
        escalationRequestToMachineEvent(state, broken as never, 3200, binding),
      ).toThrow(CourtConfirmationTransitionError);
    }
    // The wire path already refused a non-object BODY, before and after the fix.
    expect(() => parseCourtEscalationRequest(null)).toThrow(/must be a JSON object/);
  });
});

describe('(r49 D3/D4) the two encoding corners the differential forced', () => {
  it('D3: a number field is the double its literal denotes, not the literal', () => {
    const wire = serializeCourtEscalationRequest(buildCourtEscalationRequest({ ...BASE }));
    // (a) The double of 2^53+1 is 2^53, which is OUTSIDE the safe range, so both
    // readings refuse it — the decision shows up in the VALUE, not the decision.
    expect(JSON.parse('9007199254740993')).toBe(9007199254740992);
    expect(() =>
      parseCourtEscalationRequest(wire.replace('"signedAtSec":1790000000', '"signedAtSec":9007199254740993')),
    ).toThrow(/signedAtSec/);
    // (b) …and a FRACTIONAL literal that rounds to an integer is ACCEPTED, with
    // the rounded value. An exact/decimal parser reads 9007199254740991.4, fails
    // its integer rule and refuses: same bytes, different decision (D3).
    const fractional = parseCourtEscalationRequest(
      wire.replace('"signedAtSec":1790000000', '"signedAtSec":9007199254740991.4'),
    );
    expect(fractional.signedAtSec).toBe(9007199254740991);
    // The canonical re-serialization carries the double, never the literal.
    expect(serializeCourtEscalationRequest(fractional)).toContain('"signedAtSec":9007199254740991');
  });

  it('D4: leading U+FEFF is "not canonical", trailing U+FEFF is "whitespace"', () => {
    // The canonicality test is a decoder ROUND-TRIP and a WHATWG decoder strips
    // one leading BOM — so the same invisible character is refused for two
    // different reasons depending on which edge it sits on. Both refuse, so the
    // accepted domain (and its injectivity) is unchanged; the wording is a
    // registered diagnostic wart (docs/DIFFERENTIAL_WIRE.md §5 D4).
    const leading = refusal(() => buildCourtEscalationRequest({ ...BASE, caseId: '\ufeffcourt:x' }));
    expect(leading.message).toMatch(/canonical UTF-8/);
    const trailing = refusal(() => buildCourtEscalationRequest({ ...BASE, caseId: 'court:x\ufeff' }));
    expect(trailing.message).toMatch(/leading or trailing whitespace/);
    const only = refusal(() => buildCourtEscalationRequest({ ...BASE, caseId: '\ufeff' }));
    expect(only.message).toMatch(/canonical UTF-8/);
    // Interior is fine and stays part of the digest.
    expect(() => buildCourtEscalationRequest({ ...BASE, caseId: 'court\ufeff:x' })).not.toThrow();
  });

  it('a lone surrogate is still refused (the r8-1 injectivity rule)', () => {
    for (const caseId of ['\ud800', 'a\ud800', 'a\udc00b', '\ud83d']) {
      expect(() => buildCourtEscalationRequest({ ...BASE, caseId })).toThrow(/canonical UTF-8/);
    }
    // …and a well-formed PAIR is one astral character, so it is accepted.
    expect(() => buildCourtEscalationRequest({ ...BASE, caseId: '\ud83d\ude00' })).not.toThrow();
  });
});

describe('(r49) the wire stays scalar, so depth-1 duplicate detection is sufficient', () => {
  it('every field is string | number | boolean | null, and the parser refuses a repeat', () => {
    const text = serializeCourtEscalationRequest(buildCourtEscalationRequest({ ...BASE }));
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'bondProofHash', 'bondTxid', 'caseId', 'challengerPubkey', 'concession',
        'eventId', 'round', 'roundBondProofHash', 'signedAtSec',
      ].sort(),
    );
    for (const [field, value] of Object.entries(parsed)) {
      const kind = value === null ? 'null' : typeof value;
      expect(['string', 'number', 'boolean', 'null'], `field ${field} is ${kind}`).toContain(kind);
    }
    // A nested duplicate can only sit inside a value whose scalar guard refuses
    // it first — which is why the scanner is depth-1 (REVIEW_ROUND_9 §3): the
    // object form is refused by the TYPE guard, not by the scanner.
    const nested = text.replace(/"caseId":"[^"]*"/, '"caseId":{"a":1,"a":2}');
    const nestedError = refusal(() => parseCourtEscalationRequest(nested));
    expect(nestedError.message).toMatch(/must be a non-empty string/);
    // A repeated TOP-LEVEL field is the scanner's refusal, by class.
    const repeated = text.replace('"round":', '"round":1,"round":');
    const error = refusal(() => parseCourtEscalationRequest(repeated));
    expect(error.message).toMatch(/repeats the field round/);
    // …and a decoded escape counts as the same field name.
    const escaped = text.replace('"caseId":', '"c\\u0061seId":"x","caseId":');
    expect(() => parseCourtEscalationRequest(escaped)).toThrow(/repeats the field caseId/);
  });

  it('the domain is v2 and the digest is the shared known answer', () => {
    expect(COURT_ESCALATION_REQUEST_DOMAIN).toBe('BAO-Court/Escalation/Request/v2');
    expect(hashCourtEscalationRequest(buildCourtEscalationRequest({
      ...BASE,
      caseId: 'court:market-r43-wire:1',
      challengerPubkey: '7'.repeat(64),
      bondTxid: 'd'.repeat(64),
      bondProofHash: 'e'.repeat(64),
      roundBondProofHash: 'a'.repeat(64),
      eventId: '8'.repeat(64),
    }))).toBe('38f94655c82847e158c451d02e338db9f6742d23556c029ed6b7773e0e0bab5f');
  });
});
