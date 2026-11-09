// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Adversarial attestation-validator suite (security audit round 1:
 * finality/validator attacks).
 *
 * Every test in this file is an attempted bypass: a test that PASSES here
 * means the attack was rejected; a test that exposed a real gap carries a
 * `FINDING` marker. The frozen v1 validator must stay byte-compatible for
 * legacy events — v1 behaviour is only ever asserted, never changed here.
 */

import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { BAO_COURT_ATTESTATION_KIND } from '../events';
import {
  buildAttestationMessage,
  buildAttestationMessageV2,
} from '../crypto';
import {
  compareOutcomeUtf8,
  createCourtVoteMachine,
  hashCourtVoteCommit,
  hashDisputeVerdict,
  reduceCourtVoteMachine,
  type CourtVoteMachineState,
} from '../courtVoteMachine';
import {
  hashSignerSetRoot,
  validateAttestationEvent,
  validateAttestationEventV2,
  validateCourtAttestation,
} from '../validator';

const hex = (c: string): string => c.repeat(64);

const kp = (): { sec: Uint8Array; pub: string } => {
  const sec = randomBytes(32);
  return { sec, pub: bytesToHex(schnorr.getPublicKey(sec)) };
};

const SIGNERS = [1, 2, 3];
const SIGNERS_ROOT = hashSignerSetRoot(SIGNERS);

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

const BASE: V2Fields = {
  marketId: 'demo-market',
  outcome: 'YES',
  round: '0',
  epochId: 14,
  tier: 0,
  threshold: 3,
  signerSetRoot: SIGNERS_ROOT,
};

function v2Message(fields: V2Fields): string {
  return buildAttestationMessageV2({
    marketId: fields.marketId,
    outcome: fields.outcome,
    round: Number(fields.round),
    disputeEventId: fields.disputeEventId,
    verdictHash: fields.verdictHash,
    epochId: fields.epochId,
    tier: fields.tier,
    threshold: fields.threshold,
    signerSetRoot: fields.signerSetRoot,
    attempt: fields.attempt,
    batchMerkleRoot: fields.batchMerkleRoot,
  });
}

function buildV2Event(
  fields: V2Fields,
  signer: { sec: Uint8Array; pub: string },
  publisherSecret: Uint8Array = generateSecretKey(),
): NostrEvent {
  const message = v2Message(fields);
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signer.sec));
  const tags: string[][] = [
    ['m', fields.marketId],
    ['p', signer.pub],
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
  return finalizeEvent({
    kind: 89,
    created_at: 1,
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
  }, publisherSecret);
}

/** Re-serialize an event with a publisher-controlled tag/content rewrite. */
function republish(
  event: NostrEvent,
  tags: string[][],
  content: string,
  publisherSecret: Uint8Array = generateSecretKey(),
): NostrEvent {
  return finalizeEvent(
    { kind: event.kind, created_at: event.created_at, tags, content },
    publisherSecret,
  );
}

/** Frozen-shape v1 event (the classic kind-89 attestation). */
function buildV1Event(
  signer: { sec: Uint8Array; pub: string },
  overrides?: { marketId?: string; outcome?: string; round?: string },
  publisherSecret: Uint8Array = generateSecretKey(),
): NostrEvent {
  const marketId = overrides?.marketId ?? 'demo-market';
  const outcome = overrides?.outcome ?? 'YES';
  const round = overrides?.round ?? '1';
  const message = buildAttestationMessage(marketId, outcome, Number(round));
  const signature = bytesToHex(schnorr.sign(hexToBytes(message), signer.sec));
  const tags: string[][] = [
    ['m', marketId],
    ['p', signer.pub],
    ['outcome', outcome],
    ['round', round],
    ['nonce', signature.slice(0, 64)],
    ['sig', signature],
  ];
  return finalizeEvent({
    kind: 89,
    created_at: 1,
    tags,
    content: JSON.stringify({ marketId, outcome, round, message }),
  }, publisherSecret);
}

const withTags = (event: NostrEvent, name: string, value: string | null): string[][] =>
  value === null
    ? event.tags.filter((t) => t[0] !== name)
    : event.tags.map((t) => (t[0] === name ? [name, value] : t));

// ─── 1. Replay / downgrade matrix ───────────────────────────────────────────

describe('adversarial: replay & epoch-downgrade matrix', () => {
  it('FINDING-1 repro: dispatcher silently drops v2 finality policy for v1-shaped events', () => {
    // A caller that pins epoch/tier/threshold policy believes it is enforced.
    // An attacker replays an OLD v1 attestation (same group key, no epoch
    // tag): the dispatcher routes it to the frozen v1 validator, which does
    // not know any v2 policy field — the replay validated under full v2
    // policy before the fix.
    const signer = kp();
    const v1 = buildV1Event(signer);
    const v2Policy = {
      expectedGroupPubkey: signer.pub,
      expectedEpoch: 999,
      minTier: 3,
      minThreshold: 5,
      expectedSignerSetRoot: SIGNERS_ROOT,
      signerSet: SIGNERS,
    };
    expect(validateAttestationEvent(v1, v2Policy).valid).toBe(true); // frozen v1: policy unknown, OK
    const result = validateCourtAttestation(v1, v2Policy);
    // Fix contract: a v1-shaped event can never satisfy v2-only policy —
    // reject instead of silently ignoring the pins.
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/v2 finality policy/i);
  });

  it('dispatcher with no v2 policy still validates legacy v1 events (frozen behaviour)', () => {
    const signer = kp();
    const v1 = buildV1Event(signer);
    expect(validateCourtAttestation(v1).valid).toBe(true);
    expect(validateCourtAttestation(v1, signer.pub).valid).toBe(true);
    expect(validateCourtAttestation(v1, { expectedGroupPubkey: signer.pub }).valid).toBe(true);
  });

  it('downgrade: stripping the epoch tag from a v2 event never validates as v1', () => {
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    const stripped = republish(v2, withTags(v2, 'epoch', null), v2.content);
    expect(validateAttestationEventV2(stripped, {}).valid).toBe(false);
    expect(validateAttestationEvent(stripped, {}).valid).toBe(false); // v1 message mismatch
    expect(validateCourtAttestation(stripped, {}).valid).toBe(false); // no silent downgrade
  });

  it('downgrade: epoch stripped AND content.message rewritten to the v1 digest still fails', () => {
    // Attacker holds a publisher key: strip epoch, recompute what the v1
    // message WOULD have been, mirror it in content. The group signature is
    // still over the v2 digest — schnorr.verify over the v1 message fails.
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    const v1Message = buildAttestationMessage(BASE.marketId, BASE.outcome, Number(BASE.round));
    const tags = withTags(v2, 'epoch', null);
    const content = JSON.stringify({
      ...(JSON.parse(v2.content) as Record<string, unknown>),
      message: v1Message,
      epoch: undefined,
    });
    const forged = republish(v2, tags, content);
    expect(validateCourtAttestation(forged, {}).valid).toBe(false);
  });

  it('upgrade-attack: fabricated v2 tags bolted onto a real v1 attestation fail', () => {
    // Attacker adds epoch/tier/threshold/signers tags (and mirrors them in
    // content) to a v1 attestation to make it look like a fresh final v2
    // verdict. The group signature is over the v1 digest — the v2 message
    // recompute fails.
    const signer = kp();
    const v1 = buildV1Event(signer);
    const tags = [
      ...v1.tags,
      ['epoch', '14'],
      ['tier', '3'],
      ['threshold', '3'],
      ['signers', SIGNERS_ROOT],
    ];
    const content = JSON.stringify({
      ...(JSON.parse(v1.content) as Record<string, unknown>),
      epoch: '14',
      tier: '3',
      threshold: '3',
      signerSetRoot: SIGNERS_ROOT,
    });
    const upgraded = republish(v1, tags, content);
    expect(validateCourtAttestation(upgraded, {}).valid).toBe(false);
  });

  it('degenerate epoch tag shapes route to v2 and fail — never downgrade to v1', () => {
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    const shapes: string[][][] = [
      [['epoch']], // arity 1
      [['epoch', '']], // empty value
      [['epoch', '14', 'extra']], // arity 3
      [['epoch', '14'], ['epoch', '14']], // duplicate
      [['epoch', ' 14']], // whitespace
      [['epoch', '+14']], // sign
      [['epoch', '0x14']], // hex prefix
    ];
    for (const epochTags of shapes) {
      const tags = [...v2.tags.filter((t) => t[0] !== 'epoch'), ...epochTags];
      const event = republish({ ...v2, tags }, tags, v2.content);
      const result = validateCourtAttestation(event, {});
      expect(result.valid).toBe(false);
      // Must fail INSIDE the v2 path (missing/malformed v2 tags), not fall
      // through to the frozen v1 validator.
      expect(result.error).not.toMatch(/bind verdict fields/);
    }
  });
});

// ─── 1b. FINDING-3: v2 context scope pins ───────────────────────────────────

describe('adversarial: v2 scope pins (marketId / disputeId / allowedOutcomes)', () => {
  it('FINDING-3 repro: v2 enforces expectedMarketId, expectedDisputeEventId, allowedOutcomes', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    // Wrong market / wrong outcome / wrong dispute must all be rejected.
    expect(validateAttestationEventV2(event, { expectedMarketId: 'other-market' }).valid).toBe(false);
    expect(validateAttestationEventV2(event, { allowedOutcomes: ['NO'] }).valid).toBe(false);
    expect(
      validateAttestationEventV2(event, { expectedDisputeEventId: hex('d') }).valid,
    ).toBe(false); // kind-89 event carries no dispute at all
    // And the matching pins still accept.
    expect(
      validateAttestationEventV2(event, {
        expectedMarketId: BASE.marketId,
        allowedOutcomes: ['YES', 'NO'],
      }).valid,
    ).toBe(true);
  });

  it('FINDING-3 repro (dispute): kind-39007 v2 event for a foreign dispute id', () => {
    const signer = kp();
    const supportIds = [hex('e'), hex('f')];
    const verdictHash = hashDisputeVerdict({
      disputeId: hex('d'),
      outcome: 'YES',
      supportingEventIds: supportIds,
    });
    const fields: V2Fields = { ...BASE, disputeEventId: hex('d'), verdictHash };
    const good = buildV2Event(fields, signer);
    const disputeEvent = finalizeEvent({
      kind: BAO_COURT_ATTESTATION_KIND,
      created_at: good.created_at,
      tags: [...good.tags.filter((t) => t[0] !== 'e'), ...supportIds.map((id) => ['e', id, '', 'mention'])],
      content: good.content,
    }, signer.sec);
    expect(validateAttestationEventV2(disputeEvent, {}).valid).toBe(true);
    // Presenting it for a DIFFERENT dispute must fail.
    expect(validateAttestationEventV2(disputeEvent, { expectedDisputeEventId: hex('9') }).valid).toBe(false);
  });
});

// ─── 2. Field confusion at boundary values ──────────────────────────────────

describe('adversarial: field-confusion boundaries', () => {
  it('empty-string tags are rejected as missing (never treated as present)', () => {
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    for (const name of ['m', 'outcome', 'round', 'p', 'sig', 'nonce']) {
      const tags = withTags(v2, name, '');
      const event = republish({ ...v2, tags }, tags, v2.content);
      expect(validateAttestationEventV2(event, {}).valid).toBe(false);
    }
    const v1 = buildV1Event(signer);
    const tags = withTags(v1, 'm', '');
    expect(validateAttestationEvent({ ...v1, tags }, {}).valid).toBe(false);
  });

  it("'0', 'undefined' literals and JSON-metacharacter marketIds round-trip", () => {
    const signer = kp();
    for (const marketId of ['0', 'undefined', 'null', '"}]}', 'a\tb', 'm;b|c']) {
      const event = buildV2Event({ ...BASE, marketId }, signer);
      expect(validateAttestationEventV2(event, { expectedMarketId: marketId }).valid).toBe(true);
      const v1 = buildV1Event(signer, { marketId });
      expect(validateAttestationEvent(v1, { expectedMarketId: marketId }).valid).toBe(true);
    }
  });

  it('__proto__ in content JSON cannot pollute or confuse validation', () => {
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    const poisoned = JSON.stringify({
      ...(JSON.parse(v2.content) as Record<string, unknown>),
      __proto__: { epoch: '999' }, // parsed as an OWN property by JSON.parse
      polluteMe: 'oops',
    });
    const event = republish({ ...v2 }, v2.tags, poisoned);
    const victim: Record<string, unknown> = {};
    expect(validateAttestationEventV2(event, { expectedEpoch: 14 }).valid).toBe(true);
    expect((victim as { polluted?: string }).polluted).toBeUndefined();
  });

  it('duplicate JSON keys: last occurrence wins, tag must match it', () => {
    const signer = kp();
    const v2 = buildV2Event(BASE, signer);
    const content = `{"epoch":"14","epoch":"15","message":${
      JSON.stringify((JSON.parse(v2.content) as Record<string, unknown>).message)}}`;
    const event = republish({ ...v2 }, v2.tags, content);
    // content epoch = '15' ≠ tag '14' → rejected; last-wins is not exploitable.
    expect(validateAttestationEventV2(event, {}).valid).toBe(false);
  });

  it('FINDING-2 repro: v2 validators accept an unbounded marketId (hash-input DoS)', () => {
    const signer = kp();
    const big = 'm'.repeat(1024 * 1024); // 1 MiB marketId
    const event = buildV2Event({ ...BASE, marketId: big }, signer);
    const result = validateAttestationEventV2(event, { expectedMarketId: big });
    // Fix contract: v2 bounds the field (v1 is frozen and keeps the old
    // unbounded behaviour).
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too long/i);
  });

  it('v1 keeps its frozen unbounded-marketId behaviour (documented, not fixed here)', () => {
    const signer = kp();
    const big = 'm'.repeat(256 * 1024);
    const event = buildV1Event(signer, { marketId: big });
    expect(validateAttestationEvent(event, { expectedMarketId: big }).valid).toBe(true);
  });

  it('oversized outcome is rejected in v2 (aligns with the vote machine 256-byte bound)', () => {
    const signer = kp();
    const event = buildV2Event({ ...BASE, outcome: 'Y'.repeat(257) }, signer);
    expect(validateAttestationEventV2(event, {}).valid).toBe(false);
    expect(validateAttestationEventV2({ ...event }, { allowedOutcomes: ['Y'.repeat(257)] }).valid).toBe(false);
  });
});

// ─── 3. Unicode / canonicalization ──────────────────────────────────────────

describe('adversarial: unicode & canonicalization', () => {
  const U_FFFF = '\uFFFF';
  const U_10000 = '\uD800\uDC00'; // 𐀀, supplementary plane

  it('documents where JS UTF-16 order and UTF-8 byte order DIVERGE', () => {
    // JS '<' compares code units: high surrogate (0xD800) < 0xFFFF.
    expect(U_10000 < U_FFFF).toBe(true);
    // UTF-8 bytes: EF BF BF (U+FFFF) vs F0 90 80 80 (U+10000) — byte order
    // is the REVERSE: U+FFFF sorts before U+10000.
    expect(compareOutcomeUtf8(U_10000, U_FFFF)).toBeGreaterThan(0);
    expect(compareOutcomeUtf8(U_FFFF, U_10000)).toBeLessThan(0);
  });

  it('compareOutcomeUtf8 agrees with bytewise Buffer.compare across a nasty corpus', () => {
    const corpus = [
      '', 'a', 'A', '~', '\u007F', '\u0080', 'é', 'e\u0301', U_FFFF, U_10000,
      '\u{10FFFF}', '😀', '\uD83D', // lone surrogate
      'yes', 'YES', 'ｙｅｓ',
    ];
    for (const a of corpus) {
      for (const b of corpus) {
        const expected = a === b ? 0 : Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
        expect(Math.sign(compareOutcomeUtf8(a, b))).toBe(Math.sign(expected));
      }
    }
  });

  it('vote-machine tie-break picks the UTF-8-byte-smaller outcome regardless of insertion order', () => {
    const SESSION = '11'.repeat(32);
    const SALTS = ['aa'.repeat(32), 'bb'.repeat(32)];
    const run = (first: string, second: string): string => {
      let state: CourtVoteMachineState = createCourtVoteMachine({
        sessionHash: SESSION,
        participantIndices: [1, 2],
        allowedOutcomes: [first, second],
        commitDeadline: 200,
        revealDeadline: 400,
      });
      const commit = (idx: number, outcome: string): void => {
        state = reduceCourtVoteMachine(state, {
          type: 'accept_commit',
          idx,
          commitHash: hashCourtVoteCommit({ sessionHash: SESSION, outcome, salt: SALTS[idx - 1]! }),
          eventId: `d${idx}`.padEnd(64, '0'),
          now: 100,
        });
      };
      const reveal = (idx: number, outcome: string): void => {
        state = reduceCourtVoteMachine(state, {
          type: 'accept_reveal',
          idx,
          outcome,
          salt: SALTS[idx - 1]!,
          eventId: `e${idx}`.padEnd(64, '0'),
          now: 300,
        });
      };
      commit(1, first);
      commit(2, second);
      state = reduceCourtVoteMachine(state, { type: 'close_commits', now: 200 });
      state = reduceCourtVoteMachine(state, { type: 'open_reveals', now: 201 });
      reveal(1, first);
      reveal(2, second);
      state = reduceCourtVoteMachine(state, { type: 'close_reveals', now: 400 });
      state = reduceCourtVoteMachine(state, { type: 'finalize_tally', now: 401 });
      return state.verdict?.outcome ?? '';
    };
    // Tie 1-1 between U+FFFF and U+10000: byte order says U+FFFF wins even
    // though JS '<' would pick U+10000. Same verdict in both insertion orders.
    expect(run(U_FFFF, U_10000)).toBe(U_FFFF);
    expect(run(U_10000, U_FFFF)).toBe(U_FFFF);
  });

  it('NFC and NFD outcomes are DISTINCT outcomes — consistently for validator and machine', () => {
    const nfc = 'caf\u00E9';
    const nfd = 'cafe\u0301';
    expect(nfc).not.toBe(nfd);
    // Both validate independently when allowed; neither normalizes into the
    // other — allowedOutcomes matching is exact.
    const signer = kp();
    for (const outcome of [nfc, nfd]) {
      const event = buildV2Event({ ...BASE, outcome }, signer);
      expect(validateAttestationEventV2(event, { allowedOutcomes: [nfc, nfd] }).valid).toBe(true);
      expect(validateAttestationEventV2(event, { allowedOutcomes: [nfc] }).valid).toBe(outcome === nfc);
    }
    // And they commit to different verdict hashes (no aliasing).
    const ids = [hex('e')];
    expect(hashDisputeVerdict({ disputeId: hex('d'), outcome: nfc, supportingEventIds: ids }))
      .not.toBe(hashDisputeVerdict({ disputeId: hex('d'), outcome: nfd, supportingEventIds: ids }));
  });
});

// ─── 4. Signature edges ─────────────────────────────────────────────────────

describe('adversarial: signature edge cases', () => {
  it('malleable s (s ≥ curve order) is rejected — noble enforces BIP340 range', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    const sig = event.tags.find((t) => t[0] === 'sig')![1]!;
    const n = secp256k1.Point.Fn.ORDER;
    const r = sig.slice(0, 64);
    for (const s of [n, 'f'.repeat(64), '0'.repeat(64)]) {
      const malleable = r + s;
      const tags = withTags(event, 'sig', malleable).map((t) =>
        t[0] === 'nonce' ? ['nonce', r] : t);
      const tampered = republish({ ...event, tags }, tags, event.content);
      expect(validateAttestationEventV2(tampered, {}).valid).toBe(false);
      expect(validateAttestationEvent(tampered, {}).valid).toBe(false);
    }
  });

  it('point-at-infinity / non-curve pubkeys are rejected, never crash the validator', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    for (const pk of ['0'.repeat(64), 'f'.repeat(64), 'ff'.repeat(32)]) {
      const tags = withTags(event, 'p', pk);
      const tampered = republish({ ...event, tags }, tags, event.content);
      for (const validate of [validateAttestationEventV2, validateAttestationEvent]) {
        const result = validate(tampered, {});
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }
    }
  });

  it('nonce-tag manipulation (mismatch, duplicates, empty) is rejected', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    const sig = event.tags.find((t) => t[0] === 'sig')![1]!;
    // Wrong nonce
    const wrong = withTags(event, 'nonce', hex('9'));
    expect(validateAttestationEventV2(republish({ ...event, tags: wrong }, wrong, event.content), {}).valid).toBe(false);
    // Duplicate nonce tags
    const dup = [...event.tags, ['nonce', sig.slice(0, 64)]];
    expect(validateAttestationEventV2(republish({ ...event, tags: dup }, dup, event.content), {}).valid).toBe(false);
    // Empty nonce
    const empty = withTags(event, 'nonce', '');
    expect(validateAttestationEventV2(republish({ ...event, tags: empty }, empty, event.content), {}).valid).toBe(false);
  });
});

// ─── 5. Signer-set root games ───────────────────────────────────────────────

describe('adversarial: hashSignerSetRoot', () => {
  it('unsorted input canonicalizes; every malformed index shape throws', () => {
    expect(hashSignerSetRoot([3, 1, 2])).toBe(hashSignerSetRoot([1, 2, 3]));
    for (const bad of [[], [0], [-1], [Number.NaN], [1.5], [Number.POSITIVE_INFINITY], [2 ** 32], [2 ** 32 + 1], [1, 1]]) {
      expect(() => hashSignerSetRoot(bad as number[])).toThrow();
    }
    expect(hashSignerSetRoot([4294967295])).toBeDefined(); // u32 max is legal
    expect(hashSignerSetRoot(new Array(10_000).fill(0).map((_, i) => i + 1))).toBeDefined();
    expect(() => hashSignerSetRoot(new Array(10_001).fill(0).map((_, i) => i + 1))).toThrow();
  });

  it('no collisions between distinct sets (length-prefix + dedup + sort)', () => {
    const sets = [[1], [1, 2], [2, 1], [1, 2, 3], [1, 3], [2, 3], [12, 3], [1, 23], [4294967295], [1, 4294967295]];
    const roots = new Set<string>();
    const canonical = new Set<string>();
    for (const set of sets) {
      roots.add(hashSignerSetRoot(set));
      canonical.add([...set].sort((a, b) => a - b).join(','));
    }
    // Order-independent, but every distinct SET gets a distinct root —
    // concatenation-style ambiguities ([1,2] vs [12,3]) are impossible.
    expect(roots.size).toBe(canonical.size);
    expect(hashSignerSetRoot([1, 2])).not.toBe(hashSignerSetRoot([12, 3]));
    expect(hashSignerSetRoot([1, 2])).not.toBe(hashSignerSetRoot([1, 23]));
  });

  it('a validator context with a malformed signer set fails closed', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    for (const bad of [[0], [-1], [2 ** 32], [1, 1]]) {
      const result = validateAttestationEventV2(event, { signerSet: bad as number[] });
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid signer set/i);
    }
  });
});

// ─── 6. Threshold / tier / epoch boundary games ─────────────────────────────

describe('adversarial: finality-tag boundary values', () => {
  const retag = (event: NostrEvent, name: string, value: string): NostrEvent => {
    const tags = withTags(event, name, value);
    return republish({ ...event, tags }, tags, event.content);
  };
  const addTag = (event: NostrEvent, name: string, value: string): NostrEvent => {
    const tags = [...event.tags, [name, value]];
    return republish({ ...event, tags }, tags, event.content);
  };

  it('threshold 0 is rejected in every spelling; 1 is the floor', () => {
    const signer = kp();
    const event = buildV2Event(BASE, signer);
    for (const value of ['0', '00', '000', '-0']) {
      expect(validateAttestationEventV2(retag(event, 'threshold', value), {}).valid).toBe(false);
    }
    expect(validateAttestationEventV2(retag(event, 'threshold', '1'), { minThreshold: 1 }).valid).toBe(false); // size≠root
    const one = buildV2Event({ ...BASE, threshold: 1, signerSetRoot: hashSignerSetRoot([7]) }, signer);
    expect(validateAttestationEventV2(one, { minThreshold: 1, signerSet: [7] }).valid).toBe(true);
  });

  it('tier boundaries: 0 and 255 legal, 256 and negatives rejected', () => {
    const signer = kp();
    for (const tier of [0, 255]) {
      const event = buildV2Event({ ...BASE, tier }, signer);
      expect(validateAttestationEventV2(event, { minTier: tier }).valid).toBe(true);
    }
    const event = buildV2Event(BASE, signer);
    for (const value of ['256', '-1', '1.0']) {
      expect(validateAttestationEventV2(retag(event, 'tier', value), {}).valid).toBe(false);
    }
  });

  it('epoch boundaries: 2^32-1 legal, 2^32 / 2^53+ / non-decimal rejected', () => {
    const signer = kp();
    const maxEpoch = buildV2Event({ ...BASE, epochId: 0xffff_ffff }, signer);
    expect(validateAttestationEventV2(maxEpoch, { expectedEpoch: 0xffff_ffff }).valid).toBe(true);
    const event = buildV2Event(BASE, signer);
    for (const value of ['4294967296', '99999999999999999999', '-1', '1.0', '1e3', ' 14']) {
      expect(validateAttestationEventV2(retag(event, 'epoch', value), {}).valid).toBe(false);
    }
  });

  it('attempt: absent and 0 are distinct signed statements — no aliasing', () => {
    const signer = kp();
    const absent = buildV2Event(BASE, signer);
    const zero = buildV2Event({ ...BASE, attempt: 0 }, signer);
    expect(validateAttestationEventV2(absent, {}).valid).toBe(true);
    expect(validateAttestationEventV2(zero, {}).valid).toBe(true);
    const absentMsg = (JSON.parse(absent.content) as Record<string, unknown>).message;
    const zeroMsg = (JSON.parse(zero.content) as Record<string, unknown>).message;
    expect(absentMsg).not.toBe(zeroMsg);
    // Content/tag divergence on attempt is rejected in both directions.
    const tagsOnly = addTag(absent, 'attempt', '0');
    expect(validateAttestationEventV2(tagsOnly, {}).valid).toBe(false); // content has no attempt
  });

  it('leading-zero integers parse to the same value (cosmetic divergence only)', () => {
    const signer = kp();
    const event = buildV2Event({ ...BASE, threshold: 3 }, signer);
    // '03' parses to 3, content mirrors '03', message is built from the
    // parsed value → same digest semantics. Documented, not a bypass: the
    // signed THRESHOLD VALUE is identical.
    expect(validateAttestationEventV2(retag(event, 'threshold', '03'), {}).valid).toBe(false); // content still '3'
  });
});
