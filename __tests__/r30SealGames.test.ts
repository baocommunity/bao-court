// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Round-30 transport campaign — NIP-59 SEAL GAMES.
 *
 * The envelope is not the security boundary; the seal is. These tests attack
 * each layer of a gift wrap and assert the *precise* layer that catches (or
 * cannot catch) the attack:
 *
 *   1. seal-author mismatch            → seal signature + author binding
 *   2. rumor-id recomputation          → id commitment, then the roster gate
 *   3. wrong recipient p-tag           → address gate (pre-decryption)
 *   4. self-wrapped replay             → inbox dedupe / drained state
 *   5. cross-session seal replay       → transport ACCEPTS (by NIP-59 design);
 *                                        the session hash must reject the rumor
 *   6. gift wrap to a non-roster peer  → recipient gate, zero decrypts
 *   7. wrap carrying TWO seals         → structural reject at the seal layer
 *
 * Test 5 is the interesting one: it documents a boundary honestly rather than
 * pretending the transport provides freshness. A captured seal can be
 * re-wrapped by ANYONE (that is how NIP-59 works — the seal authenticates, the
 * wrap only conceals), so replay resistance must come from the inner event's
 * session binding. Both halves are asserted.
 */

import { describe, expect, it } from 'vitest';
import { finalizeEvent, getEventHash, getPublicKey, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure';
import { nip44 } from 'nostr-tools';

import { unwrapProtocolEvent, unwrapProtocolEvents, wrapProtocolEvent } from '../nip59';
import { createCourtInbox, classifyInboundEvent } from '../courtInbox';
import { SeckeyCourtSigner } from '../courtSigner';
import { hashCourtSessionParameters, type CourtSessionParameters } from '../courtSession';
import { bindCourtProtocolEvent } from '../courtProtocolEvents';
import { buildVoteCommitEvent } from '../events';
import { buildEncryptedShareEvent } from '../dkgMessages';
import { BAO_COURT_DKG_COMMITMENT_KIND, BAO_COURT_VOTE_COMMIT_KIND } from '../eventsCommon';
import { seckey, nostrPubkey, hostPubkey, schnorrKeypair } from './helpers/keys';

const T0 = 1_787_000_000;
const LATER = T0 + 10_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function parameters(overrides: Partial<CourtSessionParameters> = {}): CourtSessionParameters {
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: 'pedpop-v1-experimental',
    disputeEventId: '11'.repeat(32),
    disputeId: 'r30:transport:1',
    marketId: 'r30-market',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_777,
    participants: [
      { idx: 1, nostrPubkey: nostrPubkey(1), hostPubkey: hostPubkey(11), bondRef: 'r30:bond:1', role: 'juror-coordinator' },
      { idx: 2, nostrPubkey: nostrPubkey(2), hostPubkey: hostPubkey(12), bondRef: 'r30:bond:2', role: 'juror' },
      { idx: 3, nostrPubkey: nostrPubkey(3), hostPubkey: hostPubkey(13), bondRef: 'r30:bond:3', role: 'juror' },
    ],
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 1,
    createdAt: T0,
    deadline: T0 + 3_600,
    ...overrides,
  };
}

/** A fully bound, signed vote-commit event for `session` by `signerByte`. */
function boundEvent(session: CourtSessionParameters, signerByte: number, createdAt: number): NostrEvent {
  const legacy = buildVoteCommitEvent({
    disputeId: session.disputeId,
    jurorIdx: signerByte,
    commitHash: '55'.repeat(32),
  });
  const bound = bindCourtProtocolEvent(legacy, session, signerByte);
  return finalizeEvent({ ...bound, created_at: createdAt } as EventTemplate, seckey(signerByte));
}

// ---------------------------------------------------------------------------
// Raw NIP-59 construction (layer by layer, so each attack is explicit)
// ---------------------------------------------------------------------------

interface Layers {
  readonly rumor: NostrEvent;
  readonly seal: NostrEvent;
  readonly wrap: NostrEvent;
}

/** Build a rumor + seal + wrap by hand, with every field under caller control. */
function buildLayers(opts: {
  readonly rumor: {
    pubkey: string;
    kind: number;
    tags: string[][];
    content: string;
    created_at?: number;
  };
  readonly rumorAuthorSk: Uint8Array;
  /** Key that SIGNS the seal (normally the rumor author). */
  readonly sealSk?: Uint8Array;
  readonly recipientPubkey: string;
  /** Override the rumor's id (undefined = honest commitment). */
  readonly rumorId?: string;
  /** Extra tags grafted onto the outer wrap. */
  readonly wrapTags?: string[][];
  /** Replacement for the single honest seal (array/object/tampered event). */
  readonly sealOverride?: unknown;
}): Layers {
  const rumorBase = {
    pubkey: opts.rumor.pubkey,
    created_at: opts.rumor.created_at ?? T0,
    kind: opts.rumor.kind,
    tags: opts.rumor.tags,
    content: opts.rumor.content,
  };
  const rumor = {
    ...rumorBase,
    id: opts.rumorId ?? getEventHash(rumorBase as NostrEvent),
  } as NostrEvent;

  const sealSk = opts.sealSk ?? opts.rumorAuthorSk;
  const sealConversation = nip44.getConversationKey(sealSk, opts.recipientPubkey);
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: T0,
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), sealConversation),
    },
    sealSk,
  );

  const ephemeralSk = schnorrKeypair().sec;
  const wrap = finalizeEvent(
    {
      kind: 1059,
      created_at: T0,
      tags: [['p', opts.recipientPubkey], ...(opts.wrapTags ?? [])],
      content: nip44.encrypt(
        JSON.stringify(opts.sealOverride ?? seal),
        nip44.getConversationKey(ephemeralSk, opts.recipientPubkey),
      ),
    },
    ephemeralSk,
  );

  return { rumor, seal, wrap };
}

/** Minimal honest rumor shape used where content does not matter. */
function simpleRumor(overrides: Partial<{ kind: number; tags: string[][]; content: string; created_at: number }> = {}) {
  return {
    pubkey: nostrPubkey(1),
    kind: overrides.kind ?? BAO_COURT_DKG_COMMITMENT_KIND,
    tags: overrides.tags ?? [['dispute', 'r30:transport:1']],
    content: overrides.content ?? '{"marker":"r30"}',
    created_at: overrides.created_at ?? T0,
  };
}

// ---------------------------------------------------------------------------
// 1. seal-author mismatch
// ---------------------------------------------------------------------------

describe('seal game 1: the seal author is the only authorship proof', () => {
  it('a seal signed by the attacker while the rumor claims juror 1 yields null', () => {
    const attacker = schnorrKeypair();
    const recipient = schnorrKeypair();
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      // The SEAL is signed by the attacker, not by the claimed author.
      sealSk: attacker.sec,
      recipientPubkey: recipient.pub,
    });

    expect(unwrapProtocolEvent(wrap, recipient.sec)).toBeNull();
    expect(unwrapProtocolEvents([wrap], recipient.sec, { kinds: [BAO_COURT_DKG_COMMITMENT_KIND] })).toEqual([]);
  });

  it('a seal signed by the rumor author survives the same check (control)', () => {
    const recipient = schnorrKeypair();
    const { wrap, rumor } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    const unwrapped = unwrapProtocolEvent(wrap, recipient.sec);
    expect(unwrapped?.id).toBe(rumor.id);
    expect(unwrapped?.pubkey).toBe(nostrPubkey(1));
  });
});

// ---------------------------------------------------------------------------
// 2. rumor-id recomputation
// ---------------------------------------------------------------------------

describe('seal game 2: rumor ids are recomputed, never trusted', () => {
  it('a rumor whose content was changed after sealing fails the id commitment', () => {
    const recipient = schnorrKeypair();
    const { seal } = buildLayers({
      rumor: simpleRumor({ content: '{"a":1}' }),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });

    // The strongest attacker that does not hold the recipient's key: re-open
    // its own seal, mutate the rumor, re-seal under the same author key. The
    // only thing left between it and a forgery is the id commitment.
    const conversation = nip44.getConversationKey(seckey(1), recipient.pub);
    const rumor = JSON.parse(nip44.decrypt(seal.content, conversation)) as NostrEvent;
    rumor.content = '{"a":2}'; // stale id, new content
    const tamperedSeal = finalizeEvent(
      { kind: 13, created_at: T0, tags: [], content: nip44.encrypt(JSON.stringify(rumor), conversation) },
      seckey(1),
    );
    const ephemeral = schnorrKeypair().sec;
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: T0,
        tags: [['p', recipient.pub]],
        content: nip44.encrypt(
          JSON.stringify(tamperedSeal),
          nip44.getConversationKey(ephemeral, recipient.pub),
        ),
      },
      ephemeral,
    );

    expect(unwrapProtocolEvent(wrap, recipient.sec)).toBeNull();
  });

  it('a fully consistent forgery with a recomputed id still fails the roster gate', () => {
    const attacker = schnorrKeypair();
    const recipient = schnorrKeypair();
    const session = parameters();
    // A cryptographically PERFECT message: the attacker authors the rumor, so
    // the id commits correctly, and signs the seal, so the seal verifies.
    const forgedRumor = {
      pubkey: attacker.pub,
      kind: BAO_COURT_VOTE_COMMIT_KIND,
      tags: [
        // Attacker copies the real binding tags verbatim.
        ['session', hashCourtSessionParameters(session)],
        ['dispute', session.disputeId],
        ['juror', '1'],
        ['p', nostrPubkey(1)],
      ],
      content: JSON.stringify({ commitHash: 'aa'.repeat(32) }),
      created_at: T0 + 10,
    };
    const { wrap, rumor } = buildLayers({
      rumor: forgedRumor,
      rumorAuthorSk: attacker.sec,
      recipientPubkey: recipient.pub,
    });

    // Transport: it unwraps (the wrap never claims to authenticate roster
    // membership — documenting the boundary, not a bug).
    const unwrapped = unwrapProtocolEvent(wrap, recipient.sec);
    expect(unwrapped?.id).toBe(rumor.id);
    expect(unwrapped?.pubkey).toBe(attacker.pub);

    // Protocol: the ENVELOPE author is checked against the certified roster.
    expect(
      classifyInboundEvent(unwrapped!, { session, myPubkey: recipient.pub }),
    ).toEqual({ accepted: false, reason: 'author_not_in_roster' });

    // Control: the same binding, authored by a real juror, is accepted.
    const honest = boundEvent(session, 1, T0 + 10);
    const honestWrap = buildLayers({
      rumor: { pubkey: honest.pubkey, kind: honest.kind, tags: honest.tags as string[][], content: honest.content, created_at: honest.created_at },
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    const honestRumor = unwrapProtocolEvent(honestWrap.wrap, recipient.sec)!;
    expect(
      classifyInboundEvent(honestRumor, { session, myPubkey: recipient.pub }),
    ).toEqual({ accepted: true, category: 'protocol' });
  });
});

// ---------------------------------------------------------------------------
// 3. wrong recipient p-tag
// ---------------------------------------------------------------------------

describe('seal game 3: address gates fire before any decryption', () => {
  it('a wrap p-tagged to juror 2 cannot be unwrapped by juror 1', () => {
    const recipient = schnorrKeypair();
    const other = schnorrKeypair();
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });

    expect(unwrapProtocolEvent(wrap, recipient.sec)).not.toBeNull();
    expect(unwrapProtocolEvent(wrap, other.sec)).toBeNull();
  });

  it('a compressed-pubkey p-tag is NOT accepted as addressed', () => {
    const recipient = schnorrKeypair();
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    // A 33-byte compressed form of the same key: the address gate compares
    // exact x-only hex, so this is a different (and invalid) address.
    expect(unwrapProtocolEvent(wrap, recipient.sec)).not.toBeNull();
    const compressed = finalizeEvent(
      { kind: 1059, created_at: T0, tags: [['p', '02' + recipient.pub]], content: wrap.content },
      schnorrKeypair().sec,
    );
    expect(unwrapProtocolEvent(compressed, recipient.sec)).toBeNull();
  });

  it('an inbox rejects a wrap for another recipient before any decrypt path', () => {
    const recipient = schnorrKeypair();
    const outsider = schnorrKeypair();
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    const inbox = createCourtInbox({ myPubkey: outsider.pub });
    expect(() => inbox.ingest(wrap, 'wss://relay.example', T0)).toThrowError(/not addressed/i);
    expect(inbox.listRecords()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. self-wrapped replay
// ---------------------------------------------------------------------------

describe('seal game 4: self-wrapped replay is idempotent at the inbox', () => {
  it('a juror wrapping to itself drains once, and a re-ingested copy never re-drains', async () => {
    const self = schnorrKeypair();
    const wrap = wrapProtocolEvent(
      { kind: BAO_COURT_DKG_COMMITMENT_KIND, tags: [['dispute', 'r30:transport:1']], content: '{"x":1}', created_at: T0 } as never,
      self.sec,
      self.pub,
    );

    const inbox = createCourtInbox({ myPubkey: self.pub });
    expect(inbox.ingest(wrap, 'wss://relay-a.example', T0).duplicate).toBe(false);

    const signer = new SeckeyCourtSigner(self.sec);
    const drained = await inbox.drain(signer);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.rumor.pubkey).toBe(self.pub);

    // Relay redelivery of the exact same wrap: provenance grows, drain is empty.
    const again = inbox.ingest(wrap, 'wss://relay-b.example', T0 + 60);
    expect(again.duplicate).toBe(true);
    expect(again.record.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);
    expect(await inbox.drain(signer)).toEqual([]);
  });

  it('a replay with an earlier `now` never rewinds firstSeen/lastSeen', () => {
    const self = schnorrKeypair();
    const wrap = wrapProtocolEvent(
      { kind: BAO_COURT_DKG_COMMITMENT_KIND, tags: [['dispute', 'r30:transport:1']], content: '{"x":1}', created_at: T0 } as never,
      self.sec,
      self.pub,
    );
    const inbox = createCourtInbox({ myPubkey: self.pub });
    inbox.ingest(wrap, 'wss://relay.example', T0 + 500);
    const replay = inbox.ingest(wrap, 'wss://relay.example', T0);
    expect(replay.record.firstSeen).toBe(T0 + 500);
    expect(replay.record.lastSeen).toBe(T0 + 500);
  });
});

// ---------------------------------------------------------------------------
// 5. cross-session seal replay (THE boundary case)
// ---------------------------------------------------------------------------

describe('seal game 5: cross-session seal replay — transport cannot stop it, session binding must', () => {
  // Two OVERLAPPING sessions (concurrent disputes) — the harder case: the
  // replayed message is still "fresh" for session B, so freshness cannot save
  // us and only the session binding can.
  const sessionA = parameters({ disputeId: 'r30:session:A', createdAt: T0, deadline: T0 + 3_600 });
  const sessionB = parameters({ disputeId: 'r30:session:B', createdAt: T0 + 5, deadline: T0 + 3_605 });
  // A LATER session, where the same replay is caught by freshness first.
  const sessionC = parameters({ disputeId: 'r30:session:C', createdAt: LATER, deadline: LATER + 3_600 });
  const recipient = schnorrKeypair();

  it('anyone can re-wrap a captured seal into a fresh, valid gift wrap', () => {
    const genuine = boundEvent(sessionA, 2, T0 + 10);
    const { seal } = buildLayers({
      rumor: {
        pubkey: genuine.pubkey,
        kind: genuine.kind,
        tags: genuine.tags as string[][],
        content: genuine.content,
        created_at: genuine.created_at,
      },
      rumorAuthorSk: seckey(2),
      recipientPubkey: recipient.pub,
    });

    // An attacker holding NO keys at all re-wraps the captured seal during
    // session B. The seal is genuine, so the unwrap succeeds.
    const attackerEphemeral = schnorrKeypair().sec;
    const replayedWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: sessionB.createdAt,
        tags: [['p', recipient.pub]],
        content: nip44.encrypt(
          JSON.stringify(seal),
          nip44.getConversationKey(attackerEphemeral, recipient.pub),
        ),
      },
      attackerEphemeral,
    );

    const unwrapped = unwrapProtocolEvent(replayedWrap, recipient.sec);
    expect(unwrapped).not.toBeNull();

    // The defence is the INNER session binding, evaluated by the receiver.
    expect(
      classifyInboundEvent(unwrapped!, { session: sessionB, myPubkey: recipient.pub }),
    ).toEqual({ accepted: false, reason: 'session_mismatch' });
    // …and a later session rejects it even earlier, on freshness.
    expect(
      classifyInboundEvent(unwrapped!, { session: sessionC, myPubkey: recipient.pub }),
    ).toEqual({ accepted: false, reason: 'stale_session' });
    // …and it is still perfectly valid mail for session A.
    expect(
      classifyInboundEvent(unwrapped!, { session: sessionA, myPubkey: recipient.pub }),
    ).toEqual({ accepted: true, category: 'protocol' });
    expect(
      (unwrapped!.tags as string[][]).find((t) => t[0] === 'session')?.[1],
    ).toBe(hashCourtSessionParameters(sessionA));
  });

  it('a session-A rumor drains through the inbox, then session B rejects it', async () => {
    const genuine = boundEvent(sessionA, 2, T0 + 10);
    const { wrap } = buildLayers({
      rumor: {
        pubkey: genuine.pubkey,
        kind: genuine.kind,
        tags: genuine.tags as string[][],
        content: genuine.content,
        created_at: genuine.created_at,
      },
      rumorAuthorSk: seckey(2),
      recipientPubkey: recipient.pub,
    });
    const inbox = createCourtInbox({ myPubkey: recipient.pub });
    inbox.ingest(wrap, 'wss://relay.example', sessionA.createdAt);
    const [message] = await inbox.drain(new SeckeyCourtSigner(recipient.sec));
    expect(message).toBeDefined();
    // The inbox drained it as a *session-A* message: rebinding the same rumor
    // into session B cannot be done by a receiver, only by the author.
    const event = {
      id: message!.rumor.id,
      pubkey: message!.rumor.pubkey,
      created_at: message!.rumor.created_at,
      kind: message!.rumor.kind,
      tags: message!.rumor.tags,
      content: message!.rumor.content,
    } as NostrEvent;
    expect(
      classifyInboundEvent(event, { session: sessionB, myPubkey: recipient.pub }),
    ).toEqual({ accepted: false, reason: 'session_mismatch' });
    expect(
      classifyInboundEvent(event, { session: sessionC, myPubkey: recipient.pub }),
    ).toEqual({ accepted: false, reason: 'stale_session' });
    expect(
      classifyInboundEvent(event, { session: sessionA, myPubkey: recipient.pub }),
    ).toEqual({ accepted: true, category: 'protocol' });
  });
});

// ---------------------------------------------------------------------------
// 6. gift wrap to a non-roster recipient
// ---------------------------------------------------------------------------

describe('seal game 6: a wrap addressed to a non-roster peer never reaches a juror', () => {
  it('juror 2 rejects it pre-decrypt; the outsider cannot turn it into court mail', async () => {
    const outsider = schnorrKeypair();
    const session = parameters();
    const shareEvent = buildEncryptedShareEvent({
      disputeId: session.disputeId,
      fromIdx: 1,
      fromPubkey: nostrPubkey(1),
      toIdx: 99,
      toPubkey: outsider.pub,
      encryptedShare: 'ff'.repeat(48),
      phaseNonce: 'nonce-r30',
    });
    const wrap = wrapProtocolEvent(shareEvent as never, seckey(1), outsider.pub);

    // 1. A juror's inbox refuses to store it at all.
    const jurorInbox = createCourtInbox({ myPubkey: nostrPubkey(2) });
    expect(() => jurorInbox.ingest(wrap, 'wss://relay.example', T0)).toThrowError(/not addressed/i);
    expect(jurorInbox.listRecords()).toHaveLength(0);

    // 2. Structural classification agrees.
    expect(
      classifyInboundEvent(wrap, { session, myPubkey: nostrPubkey(2) }),
    ).toEqual({ accepted: false, reason: 'not_addressed_to_me' });

    // 3. The outsider CAN decrypt (it is addressed to them) — but their index
    //    is outside the certified roster, so no juror will act on the payload.
    const outsiderInbox = createCourtInbox({ myPubkey: outsider.pub });
    outsiderInbox.ingest(wrap, 'wss://relay.example', T0);
    const drained = await outsiderInbox.drain(new SeckeyCourtSigner(outsider.sec));
    expect(drained).toHaveLength(1);
    expect(drained[0]!.rumor.pubkey).toBe(nostrPubkey(1));
    const payload = JSON.parse(drained[0]!.rumor.content) as { toIdx: number };
    expect(payload.toIdx).toBe(99);
    expect(session.participants.some((p) => p.idx === payload.toIdx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. wrap carrying TWO seals
// ---------------------------------------------------------------------------

describe('seal game 7: a wrap carrying two seals is structurally rejected', () => {
  it('a JSON array of two valid seals is not a seal', () => {
    const recipient = schnorrKeypair();
    const { seal } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    const { seal: secondSeal } = buildLayers({
      rumor: simpleRumor({ content: '{"other":true}' }),
      rumorAuthorSk: seckey(2),
      recipientPubkey: recipient.pub,
    });
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
      sealOverride: [seal, secondSeal],
    });

    expect(unwrapProtocolEvent(wrap, recipient.sec)).toBeNull();
  });

  it('two seals concatenated as text are not a seal', () => {
    const recipient = schnorrKeypair();
    const { seal } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    const { seal: secondSeal } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(2),
      recipientPubkey: recipient.pub,
    });
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
      sealOverride: `${JSON.stringify(seal)}${JSON.stringify(secondSeal)}`,
    });
    expect(unwrapProtocolEvent(wrap, recipient.sec)).toBeNull();
  });

  it('a seal with a grafted second-seal tag breaks its own signature', () => {
    const recipient = schnorrKeypair();
    const { seal } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
    });
    const { wrap } = buildLayers({
      rumor: simpleRumor(),
      rumorAuthorSk: seckey(1),
      recipientPubkey: recipient.pub,
      sealOverride: { ...seal, tags: [['seal2', 'deadbeef']] },
    });
    // Tags are part of the signed serialization: nothing rides along unnoticed.
    expect(unwrapProtocolEvent(wrap, recipient.sec)).toBeNull();
  });
});
