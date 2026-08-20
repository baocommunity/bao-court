// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  CourtProtocolEventError,
  bindCourtProtocolEvent,
  classifyCourtProtocolEvent,
  parseBoundDkgCommitmentEvent,
  parseBoundFrostCommitEvent,
  parseBoundFrostRevealEvent,
  parseBoundVoteCommitEvent,
  parseBoundVoteRevealEvent,
  parseCourtProtocolEvent,
  parseLegacyCourtEventForHistory,
} from '../courtProtocolEvents';
import { CourtSessionValidationError, type CourtSessionParameters } from '../courtSession';
import {
  BAO_COURT_VOTE_COMMIT_KIND,
  buildDkgCommitmentEvent,
  buildFrostCommitEvent,
  buildFrostRevealEvent,
  buildVoteCommitEvent,
  buildVoteRevealEvent,
} from '../events';

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

function parameters(): CourtSessionParameters {
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: 'pedpop-v1-experimental',
    disputeEventId: '11'.repeat(32),
    disputeId: 'dispute:bound-events:1',
    marketId: 'market-bound-events',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_001,
    participants: [
      {
        idx: 1,
        nostrPubkey: nostrPubkey(1),
        hostPubkey: hostPubkey(11),
        bondRef: 'signet:bond:event-one',
        role: 'juror-coordinator',
      },
      {
        idx: 2,
        nostrPubkey: nostrPubkey(2),
        hostPubkey: hostPubkey(12),
        bondRef: 'signet:bond:event-two',
        role: 'juror',
      },
    ],
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 3,
    createdAt: 1_787_000_000,
    deadline: 1_787_003_600,
  };
}

function legacyTemplate(): EventTemplate {
  return buildVoteCommitEvent({
    disputeId: parameters().disputeId,
    jurorIdx: 1,
    commitHash: '55'.repeat(32),
  });
}

function boundTemplate(): EventTemplate {
  return bindCourtProtocolEvent(legacyTemplate(), parameters(), 1);
}

function sign(template: EventTemplate, signer = secret(1)): Event {
  return finalizeEvent(template, signer);
}

function replaceTag(template: EventTemplate, name: string, value: string): EventTemplate {
  return {
    ...template,
    tags: template.tags.map((tag) => (tag[0] === name ? [name, value] : tag)),
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(
      error instanceof CourtProtocolEventError || error instanceof CourtSessionValidationError,
    ).toBe(true);
    expect((error as CourtProtocolEventError | CourtSessionValidationError).code).toBe(code);
  }
}

describe('bound Court protocol events', () => {
  it('builds, signs, and strictly parses one session-bound event', () => {
    const params = parameters();
    const event = sign(boundTemplate());
    const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_VOTE_COMMIT_KIND]);

    expect(classifyCourtProtocolEvent(event)).toBe('bound-v1');
    expect(parsed.participant).toEqual(params.participants[0]);
    expect(parsed.binding).toMatchObject({
      version: 1,
      suite: params.cryptoSuite,
      attempt: params.attempt,
      disputeId: params.disputeId,
      jurorIdx: 1,
      nostrPubkey: params.participants[0].nostrPubkey,
      hostPubkey: params.participants[0].hostPubkey,
    });
    expect(parsed.payload).toMatchObject({
      disputeId: params.disputeId,
      jurorIdx: 1,
      commitHash: '55'.repeat(32),
    });
    expect(parsed.payload).not.toHaveProperty('court');
  });

  it('emits every required binding exactly once', () => {
    const template = boundTemplate();
    for (const name of ['session', 'suite', 'attempt', 'dispute', 'juror', 'p', 'host']) {
      expect(template.tags.filter((tag) => tag[0] === name)).toHaveLength(1);
    }
  });

  it('rejects duplicate, missing, malformed, and non-canonical required tags', () => {
    const params = parameters();
    const template = boundTemplate();
    const sessionTag = template.tags.find((tag) => tag[0] === 'session');
    if (!sessionTag) throw new Error('missing test session tag');

    expectCode(
      () => parseCourtProtocolEvent(
        sign({ ...template, tags: [...template.tags, [...sessionTag]] }),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'duplicate_tag',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign({ ...template, tags: template.tags.filter((tag) => tag[0] !== 'suite') }),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'missing_tag',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign({
          ...template,
          tags: template.tags.map((tag) => (tag[0] === 'host' ? [...tag, 'extra'] : tag)),
        }),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'invalid_tag',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'attempt', '03')),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'invalid_tag',
    );
  });

  it('rejects wrong sessions, suites, attempts, disputes, and kinds', () => {
    const params = parameters();
    const template = boundTemplate();
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'session', '00'.repeat(32))),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'wrong_session',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'suite', 'chilldkg-0.3+bip445-draft')),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'wrong_suite',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'attempt', '4')),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'wrong_attempt',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'dispute', 'another-dispute')),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'wrong_dispute',
    );
    expectCode(
      () => parseCourtProtocolEvent(sign(template), params, [39014]),
      'unexpected_kind',
    );
  });

  it('rejects author, index, p-tag, and host-key impersonation', () => {
    const params = parameters();
    const template = boundTemplate();
    expectCode(
      () => parseCourtProtocolEvent(
        sign(template, secret(2)),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'participant_binding_mismatch',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(template, secret(4)),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'participant_binding_mismatch',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'p', params.participants[1].nostrPubkey)),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'tag_content_mismatch',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'host', params.participants[1].hostPubkey)),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'participant_binding_mismatch',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign(replaceTag(template, 'juror', '2')),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'participant_binding_mismatch',
    );
  });

  it('rejects invalid signatures and tag/content disagreement', () => {
    const params = parameters();
    const event = sign(boundTemplate());
    expectCode(
      () => parseCourtProtocolEvent(
        { ...event, sig: '00'.repeat(64) },
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'invalid_signature',
    );

    const content = JSON.parse(boundTemplate().content) as Record<string, unknown>;
    const binding = content.court as Record<string, unknown>;
    expectCode(
      () => parseCourtProtocolEvent(
        sign({
          ...boundTemplate(),
          content: JSON.stringify({ ...content, court: { ...binding, attempt: 4 } }),
        }),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'tag_content_mismatch',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign({
          ...boundTemplate(),
          content: JSON.stringify({ ...content, disputeId: 'another-dispute' }),
        }),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'tag_content_mismatch',
    );
    expectCode(
      () => parseCourtProtocolEvent(
        sign({
          ...boundTemplate(),
          content: JSON.stringify({
            ...content,
            court: { ...binding, ignoredByHash: 'dangerous' },
          }),
        }),
        params,
        [BAO_COURT_VOTE_COMMIT_KIND],
      ),
      'invalid_content',
    );
  });

  it('keeps signed legacy events available only through the history parser', () => {
    const legacy = sign(legacyTemplate());
    const bound = sign(boundTemplate());

    expect(classifyCourtProtocolEvent(legacy)).toBe('legacy');
    expect(parseLegacyCourtEventForHistory(legacy, [BAO_COURT_VOTE_COMMIT_KIND])).toEqual({
      event: legacy,
      legacy: true,
    });
    expectCode(
      () => parseCourtProtocolEvent(legacy, parameters(), [BAO_COURT_VOTE_COMMIT_KIND]),
      'missing_tag',
    );
    expectCode(
      () => parseLegacyCourtEventForHistory(bound, [BAO_COURT_VOTE_COMMIT_KIND]),
      'invalid_content',
    );
  });

  it('classifies partially upgraded envelopes as invalid', () => {
    const template = legacyTemplate();
    expect(classifyCourtProtocolEvent({
      ...template,
      tags: [...template.tags, ['session', '00'.repeat(32)]],
    })).toBe('invalid');
    expect(classifyCourtProtocolEvent({ ...template, content: 'not-json' })).toBe('invalid');
  });

  it('refuses to overwrite reserved or contradictory template content', () => {
    const params = parameters();
    expectCode(
      () => bindCourtProtocolEvent(
        { ...legacyTemplate(), content: JSON.stringify({ court: {} }) },
        params,
        1,
      ),
      'reserved_content',
    );
    expectCode(
      () => bindCourtProtocolEvent(
        { ...legacyTemplate(), content: JSON.stringify({ disputeId: 'wrong', jurorIdx: 1 }) },
        params,
        1,
      ),
      'tag_content_mismatch',
    );
    expectCode(
      () => bindCourtProtocolEvent(
        { ...legacyTemplate(), content: JSON.stringify({ disputeId: params.disputeId, jurorIdx: 2 }) },
        params,
        1,
      ),
      'tag_content_mismatch',
    );
  });

  it('strictly parses DKG payloads and rejects tag/content fallback', () => {
    const params = parameters();
    const dkg = buildDkgCommitmentEvent({
      disputeId: params.disputeId,
      jurorIdx: 1,
      jurorPubkey: params.participants[0].nostrPubkey,
      threshold: params.threshold,
      vssCommits: [hostPubkey(21), hostPubkey(22)],
      pok: { nonce: hostPubkey(23), response: '66'.repeat(32) },
      phaseNonce: '77'.repeat(32),
    });
    const template = bindCourtProtocolEvent(dkg, params, 1);
    const parsed = parseBoundDkgCommitmentEvent(sign(template), params);

    expect(parsed.threshold).toBe(2);
    expect(parsed.phaseNonce).toBe('77'.repeat(32));
    expect(parsed.commitments).toEqual([hostPubkey(21), hostPubkey(22)]);

    const content = JSON.parse(template.content) as Record<string, unknown>;
    expectCode(
      () => parseBoundDkgCommitmentEvent(sign({
        ...template,
        content: JSON.stringify({ ...content, phaseNonce: '88'.repeat(32) }),
      }), params),
      'tag_content_mismatch',
    );
    expectCode(
      () => parseBoundDkgCommitmentEvent(sign({
        ...template,
        tags: [...template.tags, ['threshold', '2']],
      }), params),
      'duplicate_tag',
    );
  });

  it('strictly parses vote commits and reveals against frozen outcomes', () => {
    const params = parameters();
    const commit = sign(bindCourtProtocolEvent(legacyTemplate(), params, 1));
    const revealTemplate = bindCourtProtocolEvent(buildVoteRevealEvent({
      disputeId: params.disputeId,
      jurorIdx: 1,
      outcome: 'YES',
      salt: '88'.repeat(32),
    }), params, 1);

    expect(parseBoundVoteCommitEvent(commit, params).commitHash).toBe('55'.repeat(32));
    expect(parseBoundVoteRevealEvent(sign(revealTemplate), params)).toMatchObject({
      outcome: 'YES',
      salt: '88'.repeat(32),
    });
    expectCode(
      () => parseBoundVoteRevealEvent(
        sign(replaceTag(revealTemplate, 'outcome', 'MAYBE')),
        params,
      ),
      'invalid_tag',
    );
    expectCode(
      () => parseBoundVoteCommitEvent(
        sign(replaceTag(boundTemplate(), 'commit', 'AA'.repeat(32))),
        params,
      ),
      'invalid_tag',
    );
  });

  it('strictly parses FROST commitment and reveal payloads', () => {
    const params = parameters();
    // Nonce points must decode to real secp256k1 curve points, so derive them
    // from valid compressed public keys instead of arbitrary hex.
    const binder = hostPubkey(21);
    const hidden = hostPubkey(22);
    const commitmentTemplate = bindCourtProtocolEvent(buildFrostCommitEvent({
      disputeId: params.disputeId,
      jurorIdx: 1,
      commitmentPackage: {
        idx: 1,
        binder_pn: binder,
        hidden_pn: hidden,
      },
    }), params, 1);
    const revealTemplate = bindCourtProtocolEvent(buildFrostRevealEvent({
      disputeId: params.disputeId,
      jurorIdx: 1,
      publicNonce: {
        idx: 1,
        binder_pn: binder,
        hidden_pn: hidden,
      },
      partialSig: 'bb'.repeat(64),
      frostPubkey: hostPubkey(24),
    }), params, 1);

    expect(parseBoundFrostCommitEvent(sign(commitmentTemplate), params).commitmentPackage)
      .toEqual({ idx: 1, binder_pn: binder, hidden_pn: hidden });
    expect(parseBoundFrostRevealEvent(sign(revealTemplate), params)).toMatchObject({
      frostPubkey: hostPubkey(24),
      partialSig: 'bb'.repeat(64),
      publicNonce: { idx: 1, binder_pn: binder, hidden_pn: hidden },
    });

    const content = JSON.parse(commitmentTemplate.content) as Record<string, unknown>;
    const commitment = content.commitmentPackage as Record<string, unknown>;
    expectCode(
      () => parseBoundFrostCommitEvent(sign({
        ...commitmentTemplate,
        content: JSON.stringify({
          ...content,
          commitmentPackage: { ...commitment, hidden_pn: 'cc'.repeat(32) },
        }),
      }), params),
      'tag_content_mismatch',
    );
  });
});
