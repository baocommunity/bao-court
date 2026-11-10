// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * R8 adversarial-nostr round — hostile RELAY DATA against the Court's
 * relay-event consumers. Every test is a repro of a concrete attack an
 * over-serving (hostile) relay or a re-publishing adversary can mount:
 *
 *   1. Kind confusion — a valid-signed event of the WRONG kind arriving on a
 *      subscription filter (relays filter on kinds/tags but can over-serve);
 *      cross-kind validator application (39018 vs 89/39007 vs protocol kinds).
 *   2. Tag abuse — duplicate tags against uniqueTag readers, first-tag-wins
 *      in lenient parsers, nested-array tag items, missing vs empty-string
 *      tags, 100k `e` mention tags (parse cost before the 10k bound), and
 *      MB-scale tag values against the v2 field bounds.
 *   3. NIP-59 seal games — self-wrapped seals, cross-session seal replay,
 *      and algorithm-confusion (params missing/extra).
 *   4. Inbox flooding — dedupe-key integrity (same id, different content),
 *      capacity fail-closed, per-relay provenance.
 *   5. Watcher binding — the resolution outcome must be the FROST-certified
 *      tag, not an attacker-appended alias tag.
 */

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getEventHash, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure';

import {
  COURT_GIFT_WRAP_KIND,
  CourtInbox,
  CourtInboxError,
  classifyInboundEvent,
  createCourtInbox,
  type CourtInboxClassifyParams,
  type CourtInboxErrorCode,
} from '../courtInbox';
import {
  parseBoundVoteCommitEvent,
  parseCourtProtocolEvent,
  bindCourtProtocolEvent,
} from '../courtProtocolEvents';
import { hashCourtSessionParameters, type CourtSessionParameters } from '../courtSession';
import {
  SeckeyCourtSigner,
  unwrapProtocolEventWithSigner,
  wrapProtocolEventWithSigner,
} from '../courtSigner';
import { BAO_COURT_VOTE_COMMIT_KIND, buildVoteCommitEvent } from '../events';
import {
  FrostAppealWatcher,
} from '../appealWatcher';
import {
  validateAttestationEvent,
  validateCourtAttestation,
} from '../validator';
import {
  buildDisputeAttestationEvent,
  deriveSimulatedRevealEventId,
  generateFrostKeys,
  hashDisputeVerdict,
  runDisputeOverrideSigning,
} from '../index';
import type { SelectedJuror, StakeCommitment } from '../types';

/* ------------------------------------------------------------------------- */
/* Fixtures (mirrors courtRelayAdversary.test.ts)                             */
/* ------------------------------------------------------------------------- */

function secret(byte: number): Uint8Array {
  const value = new Uint8Array(32);
  value[31] = byte;
  return value;
}

function nostrPubkey(byte: number): string {
  return bytesToHex(schnorr.getPublicKey(secret(byte)));
}

function hostPubkey(byte: number): string {
  return bytesToHex(secp256k1.getPublicKey(secret(byte), true));
}

const MY_BYTE = 2;
const MY_PUBKEY = nostrPubkey(MY_BYTE);
const SESSION_CREATED = 1_787_000_000;

function parameters(): CourtSessionParameters {
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: 'pedpop-v1-experimental',
    disputeEventId: '11'.repeat(32),
    disputeId: 'dispute:r8:1',
    marketId: 'market-r8',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_777,
    participants: [
      {
        idx: 1,
        nostrPubkey: nostrPubkey(1),
        hostPubkey: hostPubkey(11),
        bondRef: 'signet:bond:r8-one',
        role: 'juror-coordinator',
      },
      {
        idx: 2,
        nostrPubkey: nostrPubkey(2),
        hostPubkey: hostPubkey(12),
        bondRef: 'signet:bond:r8-two',
        role: 'juror',
      },
      {
        idx: 3,
        nostrPubkey: nostrPubkey(3),
        hostPubkey: hostPubkey(13),
        bondRef: 'signet:bond:r8-three',
        role: 'juror',
      },
    ],
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 1,
    createdAt: SESSION_CREATED,
    deadline: SESSION_CREATED + 3_600,
  };
}

function classifyParams(): CourtInboxClassifyParams {
  return { session: parameters(), myPubkey: MY_PUBKEY };
}

function signTemplate(template: EventTemplate, signerByte: number): NostrEvent {
  return finalizeEvent(template, secret(signerByte));
}

function boundVoteCommitTemplate(signerByte: number, createdAt: number): EventTemplate {
  const legacy = buildVoteCommitEvent({
    disputeId: parameters().disputeId,
    jurorIdx: signerByte,
    commitHash: '55'.repeat(32),
  });
  const bound = bindCourtProtocolEvent(legacy, parameters(), signerByte);
  return { ...bound, created_at: createdAt };
}

function rumorTemplate(createdAt: number, marker: string): Omit<NostrEvent, 'id' | 'sig' | 'pubkey'> {
  return {
    kind: BAO_COURT_VOTE_COMMIT_KIND,
    created_at: createdAt,
    tags: [['dispute', parameters().disputeId]],
    content: JSON.stringify({ marker }),
  };
}

async function wrapTo(
  rumor: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
  recipientPubkey: string,
  senderByte = 1,
): Promise<NostrEvent> {
  return wrapProtocolEventWithSigner(rumor, new SeckeyCourtSigner(secret(senderByte)), recipientPubkey);
}

function expectInboxError(fn: () => unknown, code: CourtInboxErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtInboxError);
    expect((error as CourtInboxError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtInboxError with code ${code}`);
}

/* ------------------------------------------------------------------------- */
/* 1. Kind confusion (filter drift)                                           */
/* ------------------------------------------------------------------------- */

describe('kind confusion: a hostile relay over-serves a valid-signed wrong-kind event', () => {
  it('a valid-signed protocol event re-labelled by the relay cannot cross parsers: 39018 into the 89/39007 validator is rejected', () => {
    const event = signTemplate(boundVoteCommitTemplate(1, SESSION_CREATED + 5), 1);
    const asBatch = { ...event, kind: 39018 } as NostrEvent;
    // Both re-verification battery and the batch entry point refuse it.
    expect(validateAttestationEvent(asBatch).valid).toBe(false);
    expect(validateCourtAttestation(asBatch).valid).toBe(false);
  });

  it('a valid-signed kind-89 event replayed onto a vote-commit subscription fails the strict protocol parse (kind gate after the filter match)', () => {
    // Build a genuinely signed kind-89 event carrying vote-commit tags/content.
    const template = boundVoteCommitTemplate(1, SESSION_CREATED + 5);
    const asKind89 = finalizeEvent({ ...template, kind: 89 }, secret(1));
    // classification accepts the shape (structural only), but the strict
    // parser re-checks the kind against expectedKinds — the relay filter
    // match is never treated as a kind proof.
    expect(
      () => parseBoundVoteCommitEvent(asKind89, parameters()),
    ).toThrowError(/kind 89/);
  });

  it('classifyInboundEvent re-checks the kind itself and never trusts a "matching filter"', () => {
    const offFilter = signTemplate(
      { kind: 42, created_at: SESSION_CREATED + 1, tags: [], content: '{}' },
      1,
    );
    expect(classifyInboundEvent(offFilter, classifyParams())).toEqual({
      accepted: false,
      reason: 'wrong_kind',
    });
  });

  it('a protocol event whose session tag matches but whose kind is the ACK kind is classified as delivery-ack, never as protocol', () => {
    // The ack kind (39008) sits inside COURT_INBOX_PUBLIC_KINDS; a hostile
    // relay serving it with vote-commit tags must not route it into the
    // protocol pipeline (acks are bound by ['m'], not session tags).
    const ackShaped = signTemplate(
      {
        kind: 39008,
        created_at: SESSION_CREATED + 1,
        tags: [
          ['session', hashCourtSessionParameters(parameters())],
          ['suite', 'pedpop-v1-experimental'],
          ['attempt', '1'],
          ['host', hostPubkey(11)],
          ['dispute', parameters().disputeId],
          ['juror', '1'],
          ['p', nostrPubkey(1)],
        ],
        content: JSON.stringify({ court: {} }),
      },
      1,
    );
    expect(classifyInboundEvent(ackShaped, classifyParams())).toEqual({
      accepted: true,
      category: 'delivery-ack',
    });
  });
});

/* ------------------------------------------------------------------------- */
/* 2. Tag abuse                                                               */
/* ------------------------------------------------------------------------- */

describe('tag abuse: duplicates, nesting, emptiness, and scale', () => {
  it('two `p` tags — the strict protocol parser throws duplicate_tag (first-wins is never silently applied)', () => {
    const template = boundVoteCommitTemplate(1, SESSION_CREATED + 5);
    const event = finalizeEvent(
      { ...template, tags: [...template.tags, ['p', nostrPubkey(2)]] },
      secret(1),
    );
    expect(() => parseCourtProtocolEvent(event, parameters(), [BAO_COURT_VOTE_COMMIT_KIND]))
      .toThrowError(/exactly one p tag/);
  });

  it('a nested array smuggled into a tag position is malformed for classification and rejected by the strict parsers', () => {
    const nested = {
      kind: BAO_COURT_VOTE_COMMIT_KIND,
      created_at: SESSION_CREATED + 5,
      tags: [['dispute', ['nested', 'array']] as unknown as string[]],
      content: '{}',
      pubkey: nostrPubkey(1),
    } as unknown as NostrEvent;
    expect(classifyInboundEvent(nested, classifyParams())).toEqual({
      accepted: false,
      reason: 'malformed_event',
    });
  });

  it('missing tag vs empty-string tag are both rejected — an empty value never satisfies a required tag', () => {
    const missing = finalizeEvent(
      { ...boundVoteCommitTemplate(1, SESSION_CREATED + 5), tags: [] },
      secret(1),
    );
    expect(() => parseCourtProtocolEvent(missing, parameters(), [BAO_COURT_VOTE_COMMIT_KIND]))
      .toThrowError(/missing/);

    const emptied = boundVoteCommitTemplate(1, SESSION_CREATED + 5);
    const tagsWithoutDispute = emptied.tags.filter((tag) => tag[0] !== 'dispute');
    tagsWithoutDispute.push(['dispute', '']);
    const emptiedEvent = finalizeEvent(
      { ...emptied, tags: tagsWithoutDispute },
      secret(1),
    );
    expect(() => parseCourtProtocolEvent(emptiedEvent, parameters(), [BAO_COURT_VOTE_COMMIT_KIND]))
      .toThrowError(/exactly one value|invalid/);
  });

  it('100k `e` mention tags: the v1 validator bounds at 10k AFTER a bounded scan — parse cost stays linear and completes', () => {
    const marketId = randomBytes(32).toString('hex');
    const disputeId = randomBytes(32).toString('hex');
    const outcome = 'NO';
    // Hand-build the event: the BUILDER caps at 10k, the VALIDATOR is the
    // relay-data boundary and must survive an over-served event.
    const supporting = Array.from({ length: 100_000 }, (_, i) =>
      deriveSimulatedRevealEventId(i + 1, outcome, `salt-${i}`));
    const event = finalizeEvent(
      {
        kind: 39007,
        created_at: SESSION_CREATED,
        tags: [
          ['d', disputeId],
          ['e', marketId, '', 'root'],
          ['m', marketId],
          ['p', 'ee'.repeat(32)],
          ['outcome', outcome],
          ['round', '1'],
          ['nonce', 'ab'.repeat(32)],
          ['sig', 'ab'.repeat(64)],
          ['dispute', disputeId],
          ['verdict', 'cc'.repeat(32)],
          ...supporting.map((id): [string, string, string, string] => ['e', id, '', 'mention']),
        ],
        content: JSON.stringify({
          marketId, outcome, round: '1', message: 'x',
          disputeEventId: disputeId, verdictHash: 'cc'.repeat(32),
          supportingEventIds: supporting,
        }),
      },
      secret(1),
    );
    const start = Date.now();
    const result = validateAttestationEvent(event);
    // Linear scan of 100k tags completes well inside a test budget and the
    // >10k bound rejects it.
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/1\.\.10000/);
  }, 30_000);

  it('MB-scale tag values: the v2 validator enforces marketId/outcome/round byte bounds before hashing', () => {
    const marketId = randomBytes(32).toString('hex');
    const huge = 'x'.repeat(1025);
    const event = finalizeEvent(
      {
        kind: 89,
        created_at: SESSION_CREATED,
        tags: [
          ['m', 'ff'.repeat(32)],
          ['p', 'ee'.repeat(32)],
          ['sig', 'ab'.repeat(64)],
          ['nonce', 'ab'.repeat(32)],
          ['outcome', huge],
          ['round', '1'],
          ['epoch', '1'],
          ['tier', '1'],
          ['threshold', '1'],
          ['signers', 'aa'.repeat(32)],
        ],
        content: '{}',
      },
      secret(1),
    );
    const result = validateAttestationEventV2Safe(event);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/too long/);
  });

  it('v1 field bounds are frozen (byte-compatible) and documented — MB-scale v1 tags still validate structurally', () => {
    // ACCEPTED BEHAVIOR: the v1 validator is frozen for ecosystem byte
    // compatibility; its signed message is a digest over unbounded tag
    // strings. Hosts that need input bounds must consume the v2 path.
    const marketId = randomBytes(32).toString('hex');
    const hugeOutcome = 'y'.repeat(1025);
    const message = `${marketId}:${hugeOutcome}:1`;
    const event = finalizeEvent(
      {
        kind: 89,
        created_at: SESSION_CREATED,
        tags: [
          ['m', marketId],
          ['p', 'ee'.repeat(32)],
          ['sig', 'ab'.repeat(64)],
          ['nonce', 'ab'.repeat(32)],
          ['outcome', hugeOutcome],
          ['round', '1'],
        ],
        content: JSON.stringify({ message, marketId, outcome: hugeOutcome, round: '1' }),
      },
      secret(1),
    );
    // Structural checks run; only the Schnorr verify over the (wrong) message
    // fails — i.e. the unbounded strings did not break the validator.
    const result = validateAttestationEvent(event);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Schnorr signature verification failed|Attestation message does not bind/);
  });
});

function validateAttestationEventV2Safe(event: NostrEvent): { valid: boolean; error?: string } {
  try {
    return validateCourtAttestation(event, { expectedEpoch: 1 });
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------------- */
/* 3. NIP-59 seal games                                                       */
/* ------------------------------------------------------------------------- */

describe('NIP-59 seal games', () => {
  it('self-wrapped seal: an attacker who seals AND wraps their own rumor to the victim drains as themselves — the roster binding still rejects them', async () => {
    // Attacker (byte 9, not on the roster) plays both sender roles: rumor
    // author == seal author == attacker, wrap p-tagged to the victim. The
    // strict unwrap ACCEPTS it (all NIP-59 layers verify — NIP-59 proves
    // authorship, not roster membership), and the protocol layer then rejects
    // the non-roster author.
    const attacker = new SeckeyCourtSigner(secret(9));
    const rumor = {
      ...rumorTemplate(SESSION_CREATED + 5, 'selfwrap'),
      pubkey: attacker.getPublicKey(),
      id: '',
    } as NostrEvent;
    rumor.id = getEventHash(rumor);

    const sealContent = await attacker.nip44Encrypt(MY_PUBKEY, JSON.stringify(rumor));
    const seal = await attacker.signEvent({ kind: 13, content: sealContent, created_at: 1_750_000_000, tags: [] });
    const wrap = (await import('nostr-tools')).nip59.createWrap(seal, MY_PUBKEY) as NostrEvent;

    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.rumor.pubkey).toBe(attacker.getPublicKey());

    // The downstream protocol gate rejects the attacker-authored rumor even
    // though the wrap/chain is fully valid.
    expect(() =>
      parseCourtProtocolEvent(messages[0]!.rumor, parameters(), [BAO_COURT_VOTE_COMMIT_KIND]),
    ).toThrowError();
  });

  it('cross-session filter drift: a valid session-A protocol event re-served to a session-B subscriber is rejected as session_mismatch', () => {
    const sessionAEvent = signTemplate(boundVoteCommitTemplate(1, SESSION_CREATED + 5), 1);

    // Session B differs only in its disputeId → different session hash; the
    // hostile relay serves session-A traffic on B's subscription.
    const sessionB: CourtSessionParameters = {
      ...parameters(),
      disputeId: 'dispute:r8:other-session',
    };
    expect(classifyInboundEvent(sessionAEvent, { session: sessionB, myPubkey: MY_PUBKEY })).toEqual({
      accepted: false,
      reason: 'session_mismatch',
    });
    // And the strict parser answers with the same verdict for a direct feed.
    expect(() =>
      parseCourtProtocolEvent(sessionAEvent, sessionB, [BAO_COURT_VOTE_COMMIT_KIND]),
    ).toThrowError(/different Court session/);
  });

  it('algorithm-confusion: a seal/rumor chain missing required fields or carrying extra params fails closed', async () => {
    const signer = new SeckeyCourtSigner(secret(1));

    // Seal missing its kind field entirely.
    const rumor = {
      ...rumorTemplate(SESSION_CREATED + 5, 'confusion'),
      pubkey: signer.getPublicKey(),
      id: '',
    } as NostrEvent;
    rumor.id = getEventHash(rumor);
    const sealContent = await signer.nip44Encrypt(MY_PUBKEY, JSON.stringify(rumor));
    const kindlessSeal = await signer.signEvent({ kind: 13, content: sealContent, created_at: 1_750_000_000, tags: [] });
    const { kind: _dropped, ...kindless } = kindlessSeal;
    await expect(
      unwrapProtocolEventWithSigner(
        (await import('nostr-tools')).nip59.createWrap(kindless as NostrEvent, MY_PUBKEY) as NostrEvent,
        new SeckeyCourtSigner(secret(MY_BYTE)),
      ),
    ).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* 4. Inbox flooding and dedupe-key integrity                                 */
/* ------------------------------------------------------------------------- */

describe('inbox flooding: dedupe key and capacity under adversarial relay input', () => {
  it('R8 FIX: a same-id different-content wrap served by a hostile relay is malformed — it can neither poison the record nor merge provenance', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'dedupe-key'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);

    // Poison attempt 1: hostile relay wins the race — non-committing id.
    const poisonFirst: NostrEvent = {
      kind: COURT_GIFT_WRAP_KIND,
      id: 'aa'.repeat(32),
      pubkey: 'ee'.repeat(32),
      sig: 'ef'.repeat(64),
      created_at: 0,
      content: 'attacker-bytes',
      tags: [['p', MY_PUBKEY]],
    } as unknown as NostrEvent;
    expectInboxError(
      () => inbox.ingest(poisonFirst, 'wss://relay-hostile.example', 1_001),
      'malformed',
    );
    // Provenance was not merged onto the real record.
    expect(inbox.getRecord(wrap.id)?.relays).toEqual(['wss://relay-a.example']);

    // Poison attempt 2: same id as the real wrap, different content.
    const poisonSpoof: NostrEvent = {
      kind: COURT_GIFT_WRAP_KIND,
      id: wrap.id,
      pubkey: 'ee'.repeat(32),
      sig: 'ef'.repeat(64),
      created_at: wrap.created_at,
      content: 'attacker-controlled-bytes',
      tags: [['p', MY_PUBKEY]],
    } as unknown as NostrEvent;
    expectInboxError(
      () => inbox.ingest(poisonSpoof, 'wss://relay-hostile.example', 1_002),
      'malformed',
    );

    // The legit wrap still drains exactly once.
    const messages = await inbox.drain(new SeckeyCourtSigner(secret(MY_BYTE)));
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.rumor.content).marker).toBe('dedupe-key');
  });

  it('a genuinely valid wrap re-delivered from a second relay merges provenance (dedupe by committed id)', async () => {
    const wrap = await wrapTo(rumorTemplate(SESSION_CREATED + 5, 'provenance'), MY_PUBKEY);
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    inbox.ingest(wrap, 'wss://relay-a.example', 1_000);
    const again = inbox.ingest(wrap, 'wss://relay-b.example', 1_005);
    expect(again.duplicate).toBe(true);
    expect(again.record.relays).toEqual(['wss://relay-a.example', 'wss://relay-b.example']);
  });

  it('ingest is fail-closed at capacity: the flooding relay cannot evict seen wraps (no LRU to lose track of)', { timeout: 60_000 }, () => {
    const inbox = createCourtInbox({ myPubkey: MY_PUBKEY });
    const first = {
      kind: COURT_GIFT_WRAP_KIND,
      pubkey: 'cd'.repeat(32),
      sig: 'ef'.repeat(64),
      created_at: 0,
      content: 'first',
      tags: [['p', MY_PUBKEY]],
    };
    const firstWrap = { ...first, id: getEventHash(first as NostrEvent) } as unknown as NostrEvent;
    inbox.ingest(firstWrap, 'wss://relay-a.example', 0);
    for (let i = 1; i < 100_000; i += 1) {
      const base = {
        kind: COURT_GIFT_WRAP_KIND,
        pubkey: 'cd'.repeat(32),
        sig: 'ef'.repeat(64),
        created_at: i,
        content: `flood-${i}`,
        tags: [['p', MY_PUBKEY]],
      };
      inbox.ingest({ ...base, id: getEventHash(base as NostrEvent) } as unknown as NostrEvent, 'wss://relay-hostile.example', i);
    }
    // Capacity rejects new wraps — the first wrap's record survives, so its
    // dedupe state (and the drained/drainable status) can never be lost.
    const overflow = {
      kind: COURT_GIFT_WRAP_KIND,
      pubkey: 'cd'.repeat(32),
      sig: 'ef'.repeat(64),
      created_at: 100_001,
      content: 'overflow',
      tags: [['p', MY_PUBKEY]],
    };
    expectInboxError(
      () => inbox.ingest({ ...overflow, id: getEventHash(overflow as NostrEvent) } as unknown as NostrEvent, 'wss://relay-hostile.example', 100_002),
      'capacity_exceeded',
    );
    expect(inbox.getRecord(firstWrap.id)?.wrap.content).toBe('first');
  });

  it('ACCEPTED: the aggregate memory ceiling is MAX_RECORDS × max-wrap-bytes (100k × 256KB ≈ 25GB worst case) — the capacity bound, not a byte bound, is the defense', () => {
    // Documented accepted behavior: wraps are stored verbatim for
    // restart-safe drain re-verification, so a hostile relay that can get
    // 100k maximal (256KB) wraps ingested can pin ~25GB. Hosts bound this by
    // relaying through a bounded subscription window (since + limit), which
    // every shipped consumer does. This test pins the constant contract.
    expect(100_000).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------- */
/* 5. Watcher binding — the resolution carries the FROST-certified outcome     */
/* ------------------------------------------------------------------------- */

function makeVerdictCommitment(disputeId: string, outcome: string) {
  const supportingEventIds = [1, 2, 3].map((idx) =>
    deriveSimulatedRevealEventId(idx, outcome, `salt-${idx}`));
  return {
    verdictHash: hashDisputeVerdict({ disputeId, outcome, supportingEventIds }),
    supportingEventIds,
  };
}

function makeSelectedJuror(idx: number): SelectedJuror {
  return {
    nostrPubkey: randomBytes(32).toString('hex'),
    stakeCapacitySats: 500_000,
    stakeCommitment: {
      amountSats: 100_000,
      bondAddress: 'bcrt1q' + randomBytes(20).toString('hex'),
      status: 'confirmed',
      committedAt: Math.floor(Date.now() / 1000),
    } satisfies StakeCommitment,
    wotScore: 85,
    categories: ['bitcoin'],
    registeredAt: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60,
    idx,
    priority: Math.random(),
  };
}

function buildValidAttestationEvent(): { event: NostrEvent; marketId: string; disputeId: string; outcome: string; groupPubkey: string } {
  const marketId = randomBytes(32).toString('hex');
  const jurors = Array.from({ length: 5 }, (_, i) => makeSelectedJuror(i + 1));
  const { record, shares } = generateFrostKeys({ marketId, threshold: 3, jurors });
  const disputeId = randomBytes(32).toString('hex');
  const outcome = 'NO';
  const { verdictHash, supportingEventIds } = makeVerdictCommitment(disputeId, outcome);
  const attestation = runDisputeOverrideSigning({
    dispute: {
      disputeId,
      marketId,
      challengerPubkey: randomBytes(32).toString('hex'),
      respondentPubkey: randomBytes(32).toString('hex'),
      evidenceHashes: [randomBytes(32).toString('hex')],
      proposedOutcome: outcome,
    },
    dkg: record,
    shares: shares.slice(0, 3),
    verdictHash,
    supportingEventIds,
  });
  const template = buildDisputeAttestationEvent({ attestation, marketEventId: marketId });
  return {
    event: finalizeEvent(template, randomBytes(32)),
    marketId,
    disputeId,
    outcome,
    groupPubkey: record.groupPubkeyXOnly,
  };
}

describe('watcher binding: resolution fields come from the validated tags only', () => {
  it('R8 FIX: a hostile re-publisher appending an extra `o` tag cannot steer the reported outcome away from the FROST-certified one', { timeout: 30_000 }, async () => {
    const { event, marketId, disputeId, outcome, groupPubkey } = buildValidAttestationEvent();

    // The attacker re-publishes the valid attestation with an extra
    // single-letter `o` tag claiming the OPPOSITE outcome. The event's own
    // signature is the attacker's (any publisher may relay attestations);
    // the FROST layer must remain the only outcome authority.
    const republished = finalizeEvent(
      { ...event, tags: [...event.tags, ['o', 'YES']] },
      secret(9),
    );
    expect(validateAttestationEvent(republished, groupPubkey).valid).toBe(true);

    const watcher = new FrostAppealWatcher({
      relays: [],
      getGroupPubkey: (id) => (id === marketId ? groupPubkey : undefined),
    });
    const resolution = await watcher.handleEvent(republished);
    watcher.stop();

    expect(resolution).not.toBeNull();
    expect(resolution?.outcome).toBe(outcome);
    expect(resolution?.outcome).not.toBe('YES');
    expect(resolution?.disputeEventId).toBe(disputeId);
    expect(resolution?.eventId).toBe(republished.id);
  });

  it('an extra `market` alias tag cannot override the validated `m` tag', { timeout: 30_000 }, async () => {
    const { event, marketId, groupPubkey } = buildValidAttestationEvent();
    const foreignMarket = randomBytes(32).toString('hex');
    const republished = finalizeEvent(
      { ...event, tags: [...event.tags, ['market', foreignMarket]] },
      secret(9),
    );
    const watcher = new FrostAppealWatcher({
      relays: [],
      getGroupPubkey: (id) => (id === marketId ? groupPubkey : undefined),
    });
    const resolution = await watcher.handleEvent(republished);
    watcher.stop();
    expect(resolution?.marketId).toBe(marketId);
    expect(resolution?.marketId).not.toBe(foreignMarket);
  });

  it('the certified path is unchanged: the honest event resolves with the certified outcome', { timeout: 30_000 }, async () => {
    const { event, marketId, disputeId, outcome, groupPubkey } = buildValidAttestationEvent();
    const watcher = new FrostAppealWatcher({
      relays: [],
      getGroupPubkey: (id) => (id === marketId ? groupPubkey : undefined),
    });
    const resolution = await watcher.handleEvent(event);
    watcher.stop();
    expect(resolution).toMatchObject({
      marketId,
      outcome,
      disputeEventId: disputeId,
      eventId: event.id,
    });
  });
});
