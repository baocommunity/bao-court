// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Property-based invariant sweep (security round 3) — v2 attestation validator.
 *
 * Deterministic seeded generators (mulberry32 LCG — no new dependencies)
 * build really-signed v2 attestation events over random well-formed field
 * combinations and assert:
 *
 *   PV1  a correctly-signed event over ANY well-formed random field
 *        combination validates (v2 path and the validateCourtAttestation
 *        dispatcher), including under matching policy pins;
 *   PV2  the tamper matrix: ANY single-field mutation of
 *        epoch / tier / threshold / signerSetRoot / attempt / batchMerkleRoot /
 *        marketId / outcome / round / dispute / verdict — whether tag-only or
 *        tag+content-consistent — plus mutations of p / nonce / sig /
 *        content.message / created_at, invalidates the event;
 *   PV3  signer-set root pin equivalence: pinning the root, providing the
 *        full set (in any order), or both, are equivalent; a wrong root, a
 *        wrong set, or a wrong-sized set is rejected;
 *   PV4  V2_ONLY_POLICY_FIELDS downgrade refusal: a v1-shaped event (no epoch
 *        tag) is refused by the dispatcher when any v2-only finality policy
 *        field is requested, and validates on the frozen v1 path otherwise;
 *   PV5  error typing: the validator entry points never throw raw
 *        Error/TypeError/RangeError on well-shaped-but-hostile events; the
 *        one raw escape found (the dispatcher on a tags-less event) is
 *        recorded as a finding below.
 */

import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { buildAttestationMessage, buildAttestationMessageV2 } from '../crypto';
import {
  hashSignerSetRoot,
  validateAttestationEvent,
  validateAttestationEventV2,
  validateCourtAttestation,
} from '../validator';
import { mulberry32, int, pick, hex32, secFrom } from './helpers/rng';

// ─── seeded LCG: now imported from helpers/rng (mulberry32) ─────────────────

const HEX_DIGITS = '0123456789abcdef';
const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.:';
const asciiText = (r: () => number, maxLen: number): string =>
  Array.from({ length: int(r, 1, maxLen) }, () => ALPHANUM[Math.floor(r() * ALPHANUM.length)]).join('');

function flipChar(value: string, r: () => number): string {
  const pos = Math.floor(r() * value.length);
  const pool = (HEX_DIGITS.includes(value[pos]) ? HEX_DIGITS : ALPHANUM).split('')
    .filter((c) => c !== value[pos]);
  return value.slice(0, pos) + pool[Math.floor(r() * pool.length)] + value.slice(pos + 1);
}

// ─── v2 event builder over random fields ────────────────────────────────────

interface V2Fields {
  marketId: string;
  outcome: string;
  round: string;
  disputeEventId?: string;
  verdictHash?: string;
  epochId: number;
  tier: number;
  threshold: number;
  signerSetRoot: string;
  attempt?: number;
  batchMerkleRoot?: string;
}

function randomV2Fields(r: () => number): V2Fields & { signerSet: number[] } {
  const threshold = int(r, 1, 25);
  const seen = new Set<number>();
  const signerSet: number[] = [];
  while (signerSet.length < threshold) {
    const idx = int(r, 1, 200);
    if (!seen.has(idx)) {
      seen.add(idx);
      signerSet.push(idx);
    }
  }
  const fields: V2Fields & { signerSet: number[] } = {
    marketId: asciiText(r, 48),
    outcome: pick(r, ['YES', 'NO', 'spoiled', 'outcome-alpha', 'outcome-beta']),
    round: String(int(r, 0, 9999)),
    epochId: int(r, 0, 0xffff_fffe),
    tier: int(r, 0, 255),
    threshold,
    signerSetRoot: hashSignerSetRoot(signerSet),
    signerSet,
  };
  if (r() < 0.5) fields.attempt = int(r, 0, 0xffff_ffff);
  if (r() < 0.5) fields.batchMerkleRoot = hex32(r);
  if (r() < 0.4) {
    fields.disputeEventId = hex32(r);
    fields.verdictHash = hex32(r);
  }
  return fields;
}

function buildV2Event(
  fields: V2Fields,
  signerSec: Uint8Array,
  publisherSec: Uint8Array,
): NostrEvent {
  const signerPub = bytesToHex(schnorr.getPublicKey(signerSec));
  const message = buildAttestationMessageV2({
    marketId: fields.marketId,
    outcome: fields.outcome,
    round: fields.round,
    disputeEventId: fields.disputeEventId,
    verdictHash: fields.verdictHash,
    epochId: fields.epochId,
    tier: fields.tier,
    threshold: fields.threshold,
    signerSetRoot: fields.signerSetRoot,
    attempt: fields.attempt,
    batchMerkleRoot: fields.batchMerkleRoot,
  });
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signerSec));
  const tags: string[][] = [
    ['m', fields.marketId],
    ['p', signerPub],
    ['outcome', fields.outcome],
    ['round', fields.round],
    ['nonce', signature.slice(0, 64)],
    ['sig', signature],
    ['epoch', String(fields.epochId)],
    ['tier', String(fields.tier)],
    ['threshold', String(fields.threshold)],
    ['signers', fields.signerSetRoot],
  ];
  if (fields.disputeEventId) tags.push(['dispute', fields.disputeEventId]);
  if (fields.verdictHash) tags.push(['verdict', fields.verdictHash]);
  if (fields.attempt !== undefined) tags.push(['attempt', String(fields.attempt)]);
  if (fields.batchMerkleRoot) tags.push(['batch', fields.batchMerkleRoot]);
  return finalizeEvent(
    {
      kind: 89,
      created_at: 1_783_000_000,
      tags,
      content: JSON.stringify({
        marketId: fields.marketId,
        outcome: fields.outcome,
        round: fields.round,
        message,
        disputeEventId: fields.disputeEventId,
        verdictHash: fields.verdictHash,
        epoch: String(fields.epochId),
        tier: String(fields.tier),
        threshold: String(fields.threshold),
        signerSetRoot: fields.signerSetRoot,
        attempt: fields.attempt !== undefined ? String(fields.attempt) : undefined,
        batchMerkleRoot: fields.batchMerkleRoot,
      }),
    },
    publisherSec,
  );
}

/**
 * Strip nostr-tools' internal verified-event cache (an ENUMERABLE symbol-keyed
 * flag that verifyEvent sets on the event object and that object spread
 * propagates) so every validation below really recomputes the event id and
 * signature — a mutated copy of an already-validated event must be judged on
 * its merits, not by a cache hit.
 */
const fresh = (event: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(event)) as NostrEvent;

function tagValue(event: NostrEvent, name: string): string {
  const tag = event.tags.find((t) => t[0] === name);
  if (!tag || tag.length < 2 || tag[1] === undefined) throw new Error(`test bug: tag ${name} missing`);
  return tag[1];
}

function withTag(event: NostrEvent, name: string, value: string): NostrEvent {
  return fresh({
    ...event,
    tags: event.tags.map((t) => (t[0] === name ? [t[0]!, value] : t)),
  });
}

function withContent(event: NostrEvent, mutate: (content: Record<string, unknown>) => void): NostrEvent {
  const content = JSON.parse(event.content) as Record<string, unknown>;
  mutate(content);
  return fresh({ ...event, content: JSON.stringify(content) });
}

/** Flip a numeric-string field to a DIFFERENT in-range value. */
function differentInt(value: string, max: number, r: () => number): string {
  const current = Number(value);
  let next = int(r, 0, max);
  if (next === current) next = (next + 1) % (max + 1);
  return String(next);
}

function differentHex(value: string, r: () => number): string {
  return flipChar(value, r);
}

function differentText(value: string, r: () => number): string {
  return flipChar(value.length > 0 ? value : 'x', r);
}

// ─── the sweep ──────────────────────────────────────────────────────────────

const VALID_EVENTS = 120;
const TAMPER_EVENTS = 40;

describe('properties: v2 attestation validator', () => {
  const r0 = mulberry32(2026_1109);
  const samples = Array.from({ length: VALID_EVENTS }, () => {
    const fields = randomV2Fields(r0);
    const event = fresh(buildV2Event(fields, secFrom(r0), secFrom(r0)));
    return { fields, event };
  });

  it(`PV1: ${VALID_EVENTS} random well-formed field combos — valid signature validates on the v2 path, the dispatcher, and under matching policy pins`, () => {
    for (const { fields, event } of samples) {
      const result = validateAttestationEventV2(event);
      expect(result.valid, result.error).toBe(true);
      const dispatched = validateCourtAttestation(event);
      expect(dispatched.valid, dispatched.error).toBe(true);
      // Matching policy pins stay valid (minTier/minThreshold below the event's own values).
      const pinned = validateAttestationEventV2(event, {
        expectedGroupPubkey: tagValue(event, 'p'),
        expectedEpoch: fields.epochId,
        minTier: fields.tier,
        minThreshold: fields.threshold,
        expectedSignerSetRoot: fields.signerSetRoot,
        ...(fields.batchMerkleRoot !== undefined ? { expectedBatchMerkleRoot: fields.batchMerkleRoot } : {}),
        signerSet: fields.signerSet,
      });
      expect(pinned.valid, pinned.error).toBe(true);
    }
  });

  it(`PV2: tamper matrix — any single-field mutation (${TAMPER_EVENTS} events × fields × tag-only/tag+content variants) invalidates`, () => {
    const r = mulberry32(555);
    for (const { fields, event } of samples.slice(0, TAMPER_EVENTS)) {
      const fieldMutations: Array<readonly [string, string, string]> = [
        ['epoch', 'epoch', differentInt(String(fields.epochId), 0xffff_ffff, r)],
        ['tier', 'tier', differentInt(String(fields.tier), 255, r)],
        ['threshold', 'threshold', differentInt(String(fields.threshold), 0xffff_ffff, r)],
        ['signerSetRoot', 'signers', differentHex(fields.signerSetRoot, r)],
        ['marketId', 'm', differentText(fields.marketId, r)],
        ['outcome', 'outcome', differentText(fields.outcome, r)],
        ['round', 'round', differentText(fields.round, r)],
      ];
      if (fields.attempt !== undefined) {
        fieldMutations.push(['attempt', 'attempt', differentInt(String(fields.attempt), 0xffff_ffff, r)]);
      }
      if (fields.batchMerkleRoot !== undefined) {
        fieldMutations.push(['batchMerkleRoot', 'batch', differentHex(fields.batchMerkleRoot, r)]);
      }
      if (fields.disputeEventId !== undefined) {
        fieldMutations.push(['dispute', 'dispute', differentHex(fields.disputeEventId, r)]);
      }
      if (fields.verdictHash !== undefined) {
        fieldMutations.push(['verdict', 'verdict', differentHex(fields.verdictHash, r)]);
      }

      for (const [label, tagName, mutated] of fieldMutations) {
        // Variant A: tag-only mutation (content keeps the original).
        const tagOnly = withTag(event, tagName, mutated);
        const a = validateAttestationEventV2(tagOnly);
        expect(a.valid, `${label} tag-only mutation still valid: ${a.error ?? ''}`).toBe(false);
        // Variant B: tag + content mutated CONSISTENTLY (signed message now diverges).
        const contentKeys: Record<string, string> = {
          epoch: 'epoch', tier: 'tier', threshold: 'threshold', signerSetRoot: 'signerSetRoot',
          attempt: 'attempt', batchMerkleRoot: 'batchMerkleRoot',
          dispute: 'disputeEventId', verdict: 'verdictHash', m: 'marketId',
          outcome: 'outcome', round: 'round',
        };
        const contentKey = contentKeys[tagName]!;
        const consistent = withContent(withTag(event, tagName, mutated), (content) => {
          content[contentKey] = mutated;
        });
        const b = validateAttestationEventV2(consistent);
        expect(b.valid, `${label} consistent tag+content mutation still valid: ${b.error ?? ''}`).toBe(false);
        // The dispatcher refuses both variants too.
        expect(validateCourtAttestation(tagOnly).valid).toBe(false);
        expect(validateCourtAttestation(consistent).valid).toBe(false);
      }

      // Envelope mutations: p / nonce / sig (s-part) / content.message / created_at.
      const envelope: Array<readonly [string, NostrEvent]> = [
        ['p tag', withTag(event, 'p', differentHex(tagValue(event, 'p'), r))],
        ['nonce tag', withTag(event, 'nonce', differentHex(tagValue(event, 'nonce'), r))],
        ['sig s-part', withTag(event, 'sig', tagValue(event, 'sig').slice(0, 64) + flipChar(tagValue(event, 'sig').slice(64), r))],
        ['content.message', withContent(event, (content) => {
          content.message = flipChar(String(content.message), r);
        })],
        ['created_at', { ...event, created_at: event.created_at + 1 }],
      ];
      for (const [label, mutated] of envelope) {
        const result = validateAttestationEventV2(fresh(mutated));
        expect(result.valid, `envelope ${label} mutation still valid: ${result.error ?? ''}`).toBe(false);
      }
    }
  });

  it('PV3: signer-set root pin equivalence — root pin, full-set pin (any order), and both are equivalent; wrong root/set/size rejected', () => {
    const r = mulberry32(999);
    for (const { fields, event } of samples.slice(0, 30)) {
      const rootPin = validateAttestationEventV2(event, { expectedSignerSetRoot: fields.signerSetRoot });
      const setPin = validateAttestationEventV2(event, { signerSet: fields.signerSet });
      const shuffled = [...fields.signerSet];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(r() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const permutedPin = validateAttestationEventV2(event, { signerSet: shuffled });
      const bothPin = validateAttestationEventV2(event, {
        expectedSignerSetRoot: fields.signerSetRoot,
        signerSet: shuffled,
      });
      expect(rootPin.valid, rootPin.error).toBe(true);
      expect(setPin.valid, setPin.error).toBe(true);
      expect(permutedPin.valid, permutedPin.error).toBe(true);
      expect(bothPin.valid, bothPin.error).toBe(true);

      // Wrong root pinned → rejected.
      expect(
        validateAttestationEventV2(event, { expectedSignerSetRoot: differentHex(fields.signerSetRoot, r) }).valid,
      ).toBe(false);
      // Same-size set with a swapped index → rejected.
      const wrongSet = [...fields.signerSet];
      wrongSet[0] = wrongSet[0] === 200 ? 199 : wrongSet[0]! + 1;
      expect(validateAttestationEventV2(event, { signerSet: wrongSet }).valid).toBe(false);
      // Wrong-size set → rejected (root mismatch or threshold mismatch).
      expect(validateAttestationEventV2(event, { signerSet: [1, 2, 3] }).valid).toBe(false);
    }
  });

  it('PV4: V2_ONLY_POLICY_FIELDS downgrade refusal — v1-shaped events validate on the frozen v1 path but are refused under any v2-only policy pin', () => {
    const r = mulberry32(31_337);
    for (let i = 0; i < 30; i += 1) {
      const signerSec = secFrom(r);
      const signerPub = bytesToHex(schnorr.getPublicKey(signerSec));
      const marketId = asciiText(r, 32);
      const outcome = pick(r, ['YES', 'NO']);
      const round = String(int(r, 0, 99));
      const dispute = r() < 0.5 ? hex32(r) : undefined;
      const verdict = r() < 0.5 ? hex32(r) : undefined;
      const message = buildAttestationMessage(marketId, outcome, round, dispute, verdict);
      const signature = bytesToHex(schnorr.sign(hexToBytes(message), signerSec));
      const tags: string[][] = [
        ['m', marketId],
        ['p', signerPub],
        ['outcome', outcome],
        ['round', round],
        ['nonce', signature.slice(0, 64)],
        ['sig', signature],
      ];
      if (dispute) tags.push(['dispute', dispute]);
      if (verdict) tags.push(['verdict', verdict]);
      const v1Event = finalizeEvent(
        {
          kind: 89,
          created_at: 1_783_000_000,
          tags,
          content: JSON.stringify({
            marketId,
            outcome,
            round,
            message,
            disputeEventId: dispute,
            verdictHash: verdict,
          }),
        },
        secFrom(r),
      );

      // No v2 policy: the frozen v1 path validates.
      expect(validateCourtAttestation(v1Event).valid).toBe(true);
      expect(validateAttestationEvent(v1Event).valid).toBe(true);

      // Any v2-only policy field on a v1-shaped event is a refused downgrade.
      const policyPins: Array<Record<string, unknown>> = [
        { expectedEpoch: 7 },
        { minTier: 0 },
        { minThreshold: 1 },
        { expectedSignerSetRoot: hex32(r) },
        { expectedBatchMerkleRoot: hex32(r) },
        { signerSet: [1, 2, 3] },
      ];
      for (const pin of policyPins) {
        const result = validateCourtAttestation(v1Event, { expectedGroupPubkey: signerPub, ...pin } as never);
        expect(result.valid, `v1 event accepted under v2 policy pin ${Object.keys(pin)[0]}`).toBe(false);
        expect(result.error ?? '').toMatch(/downgrade refused/);
      }
    }
  });

  it('PV5: validator entry points never throw raw errors on hostile (well-shaped) events — answers are { valid: boolean }', () => {
    const r = mulberry32(867_5309);
    for (const { event } of samples.slice(0, 40)) {
      const hostile: Array<() => NostrEvent> = [
        () => ({ ...event, tags: [] }),
        () => ({ ...event, tags: [...event.tags, ['epoch', 'x']] }),
        () => ({ ...event, tags: event.tags.map((t) => (t[0] === 'epoch' ? ['epoch', '-1'] : t)) }),
        () => ({ ...event, tags: event.tags.map((t) => (t[0] === 'tier' ? ['tier', '256'] : t)) }),
        () => ({ ...event, tags: event.tags.map((t) => (t[0] === 'signers' ? ['signers', 'zz'] : t)) }),
        () => ({ ...event, tags: event.tags.filter((t) => t[0] !== 'sig') }),
        () => ({ ...event, content: '{{{' }),
        () => ({ ...event, content: '' }),
        () => ({ ...event, id: 'x'.repeat(64) }),
        () => ({ ...event, kind: 39007 }),
        () => ({ ...event, sig: 'zz'.repeat(64) }),
        () => ({ ...event, pubkey: 'ff'.repeat(32) }),
        () => ({ ...event, created_at: event.created_at + 1 }),
      ];
      for (const mutate of hostile) {
        const mutated = fresh(mutate());
        for (const validate of [validateAttestationEventV2, validateAttestationEvent]) {
          let result: unknown;
          expect(() => {
            result = validate(mutated);
          }, `${validate.name} threw`).not.toThrow();
          expect(typeof (result as { valid?: unknown })?.valid).toBe('boolean');
        }
        // Dispatcher: same hostile event WITH a tags array present.
        let dispatched: unknown;
        expect(() => {
          dispatched = validateCourtAttestation(mutated);
        }, 'validateCourtAttestation threw on a well-shaped event').not.toThrow();
        expect(typeof (dispatched as { valid?: unknown })?.valid).toBe('boolean');
      }
    }
  });

  it('PV6 (FINDING r3, FIXED in 0.9.1): validateCourtAttestation answers a TYPED invalid result for a tags-less event — the dispatcher guards event.tags before the shape dispatch', () => {
    // validateAttestationEvent / validateAttestationEventV2 bail out at
    // verifyEvent() before touching tags, but the dispatcher used to
    // dereference event.tags.some(...) unguarded. Since 0.9.1 the dispatcher
    // fails closed with the module's typed { valid, error } result.
    let result: unknown;
    expect(() => {
      result = validateCourtAttestation({ kind: 89 } as unknown as NostrEvent);
    }).not.toThrow();
    expect(result).toMatchObject({ valid: false, pubkey: '', error: 'Malformed event: tags must be an array' });
  });
});
