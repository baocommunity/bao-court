// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * MUTATION-CLOSURE PINS (round 47 — the v0.14.0 TRANSPORT campaign).
 *
 * Every test here closes a mutant that the **vitest battery** (Detector A) did
 * not see on the escalation transport, `courtEscalationRequest.ts` — the wire
 * codec v0.14.0 introduced and round 8 (r8-1…r8-5) hardened. Method, the full
 * mutant table and the honest per-detector reading: `docs/MUTATION_TESTING_V014.md`;
 * the campaign's earlier closures: `__tests__/mutationClosures.test.ts` (C1–C9)
 * and `__tests__/mutationClosuresV013.test.ts` (C10).
 *
 * WHY THESE PINS EXIST AT ALL, if the campaign's black-box probes caught the
 * mutants. Detector C (`scripts/mutation/spot-check.mjs`) is a CAMPAIGN tool: it
 * runs when someone re-runs a sweep. The battery is the gate on every PR. A
 * property that only the campaign probe asserts is a property CI does not
 * defend, and that is exactly the gap these five pins close:
 *
 *   C11 (M82)  the codec hashes the value it VALIDATED: an id is trimmed and
 *              nothing else, so `" court:1"` and `"court:1"` are one request
 *              with one digest — but the digest must not also cover bytes the
 *              wire does not carry. Dropping the trim made `build` return an
 *              id the preimage then trimmed, i.e. validate A, hash B.
 *   C12 (M83)  an accepted id round-trips BYTE-FOR-BYTE. Normalising instead of
 *              refusing is the same class as r8-1: an NFD id and its NFC twin
 *              are different wire strings, one digest, and the host's routing
 *              key is silently rewritten to an id the client never sent.
 *   C13 (M84)  `hashCourtEscalationRequest` re-validates its argument, so a
 *              hand-built object cannot be hashed without the codec seeing it.
 *   C14 (M91)  `parse` shape-checks `caseId`; it does not `String()` it. The
 *              coercion turns a MISSING field into the case id "undefined".
 *   C15 (M92)  `parse` shape-checks `round`; it does not `Number()` it. The
 *              coercion accepts `"2"`, `true` and `[2]` as round 2.
 *
 * Each pin was verified RED on the unmutated-but-reverted base: the mutation
 * was re-applied to a sandbox copy of the tree and this file re-run there (see
 * the campaign document, §5 — the transcript is in the run log).
 */

import { describe, expect, it } from 'vitest';

import {
  buildCourtEscalationRequest,
  courtEscalationRequestPreimage,
  hashCourtEscalationRequest,
  parseCourtEscalationRequest,
  serializeCourtEscalationRequest,
  type CourtEscalationRequest,
} from '../courtEscalationRequest';
import { CourtConfirmationTransitionError } from '../courtConfirmationMachine';
import { hexId, padHexId } from './helpers/ids';

const CASE_ID = 'court:market-r47-closure:1';
const CHALLENGER_PUBKEY = hexId('7');
const BOND_TXID = hexId('d');
const MEMBERSHIP_BOND = hexId('e');
const ROUND_BOND = padHexId('a2');
const EVENT_ID = hexId('8');

function request(overrides: Partial<CourtEscalationRequest> = {}): CourtEscalationRequest {
  return buildCourtEscalationRequest({
    caseId: CASE_ID,
    round: 1,
    challengerPubkey: CHALLENGER_PUBKEY,
    bondTxid: BOND_TXID,
    bondProofHash: MEMBERSHIP_BOND,
    roundBondProofHash: ROUND_BOND,
    eventId: EVENT_ID,
    signedAtSec: 1_790_000_000,
    ...overrides,
  });
}

const wireOf = (req: CourtEscalationRequest): Record<string, unknown> =>
  JSON.parse(serializeCourtEscalationRequest(req)) as Record<string, unknown>;

describe('C11 (M82) — the id that is hashed is the id that was validated', () => {
  it('a padded id is trimmed ONCE, in build, and every later step sees the trimmed id', () => {
    const padded = request({ caseId: `  ${CASE_ID}\t` });
    // The value the caller gets IS the value the digest covers…
    expect(padded.caseId).toBe(CASE_ID);
    // …so the wire form carries no byte the digest ignores.
    expect(wireOf(padded).caseId).toBe(CASE_ID);
    expect(serializeCourtEscalationRequest(padded)).toBe(serializeCourtEscalationRequest(request()));
    expect(courtEscalationRequestPreimage(padded)).toBe(courtEscalationRequestPreimage(request()));
  });

  it('a hand-built untrimmed id hashes as the trimmed one (the preimage trims nothing it did not validate)', () => {
    // `build` is the only trimming authority. A hand-built object bypasses it,
    // and the digest must still be the digest of the request the wire carries —
    // if the preimage trims something `build` did not, two wire strings share a
    // digest (the H-6 collision, one field over).
    const built = request();
    expect(hashCourtEscalationRequest({ ...built, caseId: ` ${CASE_ID} ` }))
      .toBe(hashCourtEscalationRequest(built));
    expect(hashCourtEscalationRequest({ ...built, caseId: `${CASE_ID}  ` }))
      .toBe(hashCourtEscalationRequest(built));
  });

  it('an id that is ONLY whitespace is still refused', () => {
    expect(() => request({ caseId: ' \t ' })).toThrow(/non-empty/);
  });
});

describe('C12 (M83) — an accepted id is returned byte-for-byte (no silent normalisation)', () => {
  // U+0301 COMBINING ACUTE ACCENT: valid UTF-8, canonical in the sense this
  // codec checks (it decodes back to itself), and a DIFFERENT wire string from
  // the precomposed é. A codec that normalises one into the other is r8-1
  // again: two ids, one digest, and the host routes on a key the client never
  // sent.
  const NFD = 'cafe\u0301:1';
  const NFC = 'caf\u00e9:1';

  it('NFD is accepted unchanged, and NFC is a different id', () => {
    expect(request({ caseId: NFD }).caseId).toBe(NFD);
    expect(request({ caseId: NFC }).caseId).toBe(NFC);
    expect(NFD).not.toBe(NFC);
  });

  it('the two forms do not share a digest, and the wire does not rewrite the id', () => {
    const nfd = request({ caseId: NFD });
    const nfc = request({ caseId: NFC });
    expect(hashCourtEscalationRequest(nfd)).not.toBe(hashCourtEscalationRequest(nfc));
    expect(wireOf(nfd).caseId).toBe(NFD);
    expect(wireOf(nfc).caseId).toBe(NFC);
  });

  it('a full-width / compatibility form is likewise preserved, not folded', () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A — NFKC would fold it to "A".
    const fullwidth = 'court:\uff21:1';
    expect(request({ caseId: fullwidth }).caseId).toBe(fullwidth);
    expect(hashCourtEscalationRequest(request({ caseId: fullwidth })))
      .not.toBe(hashCourtEscalationRequest(request({ caseId: 'court:A:1' })));
  });
});

describe('C13 (M84) — the digest covers the RE-VALIDATED request', () => {
  it('a hand-built request with a NUL id is refused, not hashed', () => {
    const built = request();
    expect(() => hashCourtEscalationRequest({ ...built, caseId: `a\u0000b` }))
      .toThrow(CourtConfirmationTransitionError);
  });

  it('a hand-built request with malformed hex is refused, not hashed', () => {
    const built = request();
    expect(() => hashCourtEscalationRequest({ ...built, bondProofHash: 'deadbeef' }))
      .toThrow(/bond_proof_hash/);
    expect(() => hashCourtEscalationRequest({ ...built, roundBondProofHash: 'nothex' }))
      .toThrow(/round_bond_proof_hash/);
    expect(() => hashCourtEscalationRequest({ ...built, round: 9 }))
      .toThrow(/round must be an integer/);
  });

  it('a hand-built request with an unpaired surrogate is refused (the r8-1 guard runs in hash too)', () => {
    const built = request();
    expect(() => hashCourtEscalationRequest({ ...built, caseId: `${CASE_ID}\ud800` }))
      .toThrow(/canonical UTF-8/);
  });
});

describe('C14 (M91) — parse shape-checks caseId instead of coercing it', () => {
  it('a numeric id is refused (String() would mint the id "42")', () => {
    expect(() => parseCourtEscalationRequest({ ...wireOf(request()), caseId: 42 }))
      .toThrow(CourtConfirmationTransitionError);
    expect(() => parseCourtEscalationRequest({ ...wireOf(request()), caseId: 42 }))
      .toThrow(/caseId/);
  });

  it('a MISSING id is refused (String(undefined) would mint the id "undefined")', () => {
    const wire = wireOf(request());
    delete wire.caseId;
    expect(() => parseCourtEscalationRequest(wire)).toThrow(/caseId/);
    // …and the wire still parses with the field present (over-strictness control).
    expect(parseCourtEscalationRequest(wireOf(request())).caseId).toBe(CASE_ID);
  });

  it('an id that is not a string at all never reaches the preimage', () => {
    for (const value of [42, true, {}, [], null]) {
      expect(() => parseCourtEscalationRequest({ ...wireOf(request()), caseId: value }))
        .toThrow(CourtConfirmationTransitionError);
    }
  });
});

describe('C15 (M92) — parse shape-checks round instead of coercing it', () => {
  it('a stringly round is refused (Number("2") would accept it as 2)', () => {
    for (const value of ['2', '1', ' 2 ', true, [2]]) {
      expect(() => parseCourtEscalationRequest({ ...wireOf(request()), round: value }))
        .toThrow(/round must be an integer/);
    }
  });

  it('a non-integer number is refused', () => {
    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseCourtEscalationRequest({ ...wireOf(request()), round: value }))
        .toThrow(/round must be an integer/);
    }
  });

  it('the integer rounds the ladder allows still parse (over-strictness control)', () => {
    for (const value of [1, 2, 5]) {
      expect(parseCourtEscalationRequest({ ...wireOf(request()), round: value }).round).toBe(value);
    }
  });
});
