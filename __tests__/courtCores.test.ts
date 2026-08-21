// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Regression tests for the shared ceremony/parse/unwrap cores extracted from
 * the three ceremony machines, the event parse tiers, and the two NIP-59
 * unwrap paths. The machines' own suites cover behavior through the reducers;
 * these pin the shared invariants directly.
 */

import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import {
  HEX_32,
  assertBlamedIdx,
  assertBeforeDeadline,
  assertNow,
  assertPositiveDeadline,
  assertRosterMember,
  normalizeCeremonyRoster,
} from '../courtCeremonyCore';
import {
  assertUnwrapBatchSize,
  assertValidUnwrapKinds,
  filterUnwrappedRumors,
  MAX_UNWRAP_BATCH,
} from '../courtUnwrapCore';
import {
  findTag,
  findTagValue,
  isHex64,
  parseCanonicalUint,
  parseContentObject,
  parsePositiveInt,
} from '../courtEventParseCore';

class TestTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestTransitionError';
  }
}

function fakeRumor(id: string, kind: number, disputeId?: string): NostrEvent {
  return {
    id,
    pubkey: 'a'.repeat(64),
    kind,
    content: '{}',
    tags: disputeId !== undefined ? [['dispute', disputeId]] : [],
    created_at: 1,
  } as NostrEvent;
}

describe('courtCeremonyCore', () => {
  it('assertNow rejects non-safe-integers and negative timestamps', () => {
    expect(() => assertNow(1, TestTransitionError)).not.toThrow();
    expect(() => assertNow(1.5, TestTransitionError)).toThrow('now must be a non-negative Unix timestamp');
    expect(() => assertNow(-1, TestTransitionError)).toThrow('now must be a non-negative Unix timestamp');
    expect(() => assertNow(Number.MAX_SAFE_INTEGER + 1, TestTransitionError)).toThrow(
      'now must be a non-negative Unix timestamp',
    );
  });

  it('assertPositiveDeadline rejects zero and unsafe deadlines', () => {
    expect(() => assertPositiveDeadline(1, 'deadline', TestTransitionError)).not.toThrow();
    expect(() => assertPositiveDeadline(0, 'deadline', TestTransitionError)).toThrow(
      'deadline must be a positive Unix timestamp',
    );
  });

  it('assertBeforeDeadline rejects messages at/after the deadline', () => {
    expect(() => assertBeforeDeadline(9, 10, 'late', TestTransitionError)).not.toThrow();
    expect(() => assertBeforeDeadline(10, 10, 'late', TestTransitionError)).toThrow('late');
    expect(() => assertBeforeDeadline(11, 10, 'late', TestTransitionError)).toThrow('late');
  });

  it('assertRosterMember rejects off-roster indices', () => {
    expect(() => assertRosterMember([1, 2, 3], 2, 'participant', TestTransitionError)).not.toThrow();
    expect(() => assertRosterMember([1, 2, 3], 4, 'voter', TestTransitionError)).toThrow(
      'voter 4 is outside the certified roster',
    );
  });

  it('normalizeCeremonyRoster validates order, sequentiality, and caps', () => {
    expect(normalizeCeremonyRoster([1, 2, 3], 'voting', TestTransitionError)).toEqual([1, 2, 3]);
    expect(() => normalizeCeremonyRoster([], 'voting', TestTransitionError)).toThrow(
      'voting requires at least one participant',
    );
    expect(() => normalizeCeremonyRoster([1, 3], 'voting', TestTransitionError)).toThrow(
      'participant indices must be ordered and sequential',
    );
    expect(() => normalizeCeremonyRoster([1, 2, 2], 'voting', TestTransitionError)).toThrow(
      'participant indices must be ordered and sequential',
    );
    const huge = Array.from({ length: MAX_UNWRAP_BATCH + 1 }, (_, i) => i + 1);
    expect(() => normalizeCeremonyRoster(huge, 'voting', TestTransitionError)).toThrow(
      'participantIndices length exceeds maximum of 10000',
    );
  });

  it('assertBlamedIdx validates positivity and roster membership', () => {
    expect(() => assertBlamedIdx(undefined, [1, 2], 'signer', TestTransitionError)).not.toThrow();
    expect(() => assertBlamedIdx(2, [1, 2], 'signer', TestTransitionError)).not.toThrow();
    expect(() => assertBlamedIdx(0, [1, 2], 'signer', TestTransitionError)).toThrow(
      'blamedIdx must be a positive integer',
    );
    expect(() => assertBlamedIdx(3, [1, 2], 'signer', TestTransitionError)).toThrow(
      'signer 3 is outside the certified roster',
    );
  });

  it('HEX_32 is the canonical 32-byte lowercase-hex pattern', () => {
    expect(HEX_32.test('a'.repeat(64))).toBe(true);
    expect(HEX_32.test('A'.repeat(64))).toBe(false);
    expect(HEX_32.test('a'.repeat(63))).toBe(false);
  });
});

describe('courtUnwrapCore', () => {
  it('deduplicates rumors by id', () => {
    const dup = fakeRumor('id-1', 39004, 'd1');
    const filtered = filterUnwrappedRumors([dup, dup, fakeRumor('id-2', 39004, 'd1')]);
    expect(filtered.map((r) => r.id)).toEqual(['id-1', 'id-2']);
  });

  it('filters by kind and dispute, with empty disputeId matching nothing', () => {
    const a = fakeRumor('a', 39004, 'd1');
    const b = fakeRumor('b', 39014, 'd1');
    const c = fakeRumor('c', 39004, 'd2');

    expect(filterUnwrappedRumors([a, b, c], { kinds: [39004] }).map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterUnwrappedRumors([a, b, c], { disputeId: 'd1' }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterUnwrappedRumors([a, b, c], { kinds: [39004], disputeId: 'd1' }).map((r) => r.id)).toEqual(['a']);
    // An explicitly supplied empty disputeId must match nothing.
    expect(filterUnwrappedRumors([a], { disputeId: '' })).toEqual([]);
    expect(filterUnwrappedRumors([a])).toEqual([a]);
  });

  it('drops null rumors (unwrappable) and events without ids', () => {
    const missingId = fakeRumor('', 39004) as NostrEvent;
    delete (missingId as { id?: string }).id;
    expect(filterUnwrappedRumors([null, missingId, fakeRumor('x', 39004)])).toHaveLength(1);
  });

  it('assertValidUnwrapKinds rejects out-of-range kinds', () => {
    expect(() => assertValidUnwrapKinds([39004])).not.toThrow();
    expect(() => assertValidUnwrapKinds([-1])).toThrow('Invalid kind in filter: -1');
    expect(() => assertValidUnwrapKinds([70000])).toThrow('Invalid kind in filter: 70000');
  });

  it('assertUnwrapBatchSize rejects oversized batches', () => {
    expect(() => assertUnwrapBatchSize(MAX_UNWRAP_BATCH)).not.toThrow();
    expect(() => assertUnwrapBatchSize(MAX_UNWRAP_BATCH + 1)).toThrow(
      'unwrap batch size 10001 exceeds maximum of 10000',
    );
  });
});

describe('courtEventParseCore', () => {
  it('isHex64 accepts only 64-hex (any case)', () => {
    expect(isHex64('a'.repeat(64))).toBe(true);
    expect(isHex64('A'.repeat(64))).toBe(true);
    expect(isHex64('a'.repeat(63))).toBe(false);
    expect(isHex64('g'.repeat(64))).toBe(false);
  });

  it('parseContentObject returns null for non-object content', () => {
    expect(parseContentObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseContentObject('not json')).toBeNull();
    expect(parseContentObject('[1,2]')).toBeNull();
    expect(parseContentObject('')).toEqual({});
  });

  it('findTag/findTagValue preserve whole-tag semantics', () => {
    const tags = [['dispute', 'd1'], ['juror', '2'], ['e', 'id', '', 'mention']];
    expect(findTag(tags, 'dispute')).toEqual(['dispute', 'd1']);
    expect(findTag(tags, 'missing')).toBeUndefined();
    expect(findTagValue(tags, 'juror')).toBe('2');
    expect(findTagValue(tags, 'missing')).toBeUndefined();
  });

  it('parsePositiveInt and parseCanonicalUint reject malformed values', () => {
    expect(parsePositiveInt(2)).toBe(2);
    expect(parsePositiveInt('2')).toBe(2);
    expect(parsePositiveInt(0)).toBeNull();
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('x')).toBeNull();
    expect(parseCanonicalUint('0')).toBe(0);
    expect(parseCanonicalUint('007')).toBeNull();
    expect(parseCanonicalUint('1.5')).toBeNull();
    expect(parseCanonicalUint('x')).toBeNull();
  });
});
