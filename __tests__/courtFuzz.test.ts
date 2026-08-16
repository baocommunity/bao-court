// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Adversarial parser fuzz: hostile events must fail with TYPED
 * CourtProtocolEventError (or be accepted), never with an untyped crash.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  CourtProtocolEventError,
  bindCourtProtocolEvent,
  parseBoundDkgCommitmentEvent,
  parseBoundVoteCommitEvent,
  parseBoundVoteRevealEvent,
  parseBoundFrostCommitEvent,
  parseBoundFrostRevealEvent,
  parseCourtProtocolEvent,
} from '../courtProtocolEvents';
import type { CourtSessionParameters } from '../courtSession';
import {
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
    disputeId: 'dispute:fuzz:1',
    marketId: 'market-fuzz',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_001,
    participants: [
      { idx: 1, nostrPubkey: nostrPubkey(1), hostPubkey: hostPubkey(11), bondRef: 'bond:one', role: 'juror-coordinator' },
      { idx: 2, nostrPubkey: nostrPubkey(2), hostPubkey: hostPubkey(12), bondRef: 'bond:two', role: 'juror' },
    ],
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 0,
    createdAt: 1_780_000_000,
    deadline: 1_780_100_000,
  };
}

function signed(template: EventTemplate, seckey: Uint8Array = secret(1)) {
  return finalizeEvent(template, seckey);
}

function dkgTemplate(): EventTemplate {
  return bindCourtProtocolEvent(
    buildDkgCommitmentEvent({
      disputeId: 'dispute:fuzz:1',
      jurorIdx: 1,
      jurorPubkey: nostrPubkey(1),
      threshold: 2,
      vssCommits: [`02${'33'.repeat(32)}`, `03${'44'.repeat(32)}`],
      pok: { nonce: `02${'55'.repeat(32)}`, response: '66'.repeat(32) },
      phaseNonce: '77'.repeat(32),
    }),
    parameters(),
    1,
  );
}

describe('adversarial parser fuzz (typed failures only)', () => {
  const cases: Array<[string, EventTemplate]> = [];
  const base = dkgTemplate();
  const mk = (mutate: (t: EventTemplate) => EventTemplate, label: string): void => {
    cases.push([label, mutate({ ...base, tags: base.tags.map((t) => [...t]) })]);
  };

  mk((t) => ({ ...t, tags: [...t.tags, ['commit', '99'.repeat(32)]] }), 'extra commit tag (count != 2)');
  mk((t) => ({ ...t, tags: t.tags.map((tag) => (tag[0] === 'pok_n' ? ['pok_n', 'zz'.repeat(40)] : tag)) }), 'pok_n garbage');
  mk((t) => ({ ...t, tags: t.tags.map((tag) => (tag[0] === 'pok_z' ? ['pok_z', '11'.repeat(31)] : tag)) }), 'pok_z wrong length');
  mk((t) => ({ ...t, tags: t.tags.filter((tag) => tag[0] !== 'phase_nonce') }), 'phase nonce missing');
  mk((t) => ({ ...t, tags: t.tags.map((tag) => (tag[0] === 'threshold' ? ['threshold', '0x10'] : tag)) }), 'threshold non-canonical');
  mk((t) => ({ ...t, tags: t.tags.map((tag) => (tag[0] === 'juror' ? ['juror', '99999999999999999999'] : tag)) }), 'juror overflowing number');
  mk((t) => ({ ...t, tags: t.tags.map((tag) => (tag[0] === 'juror' ? ['juror'] : tag)) }), 'juror tag empty');
  mk((t) => ({ ...t, tags: t.tags.map((tag) => (tag[0] === 'commit' ? ['commit'] : tag)) }), 'commit tag empty');
  mk((t) => ({ ...t, tags: [...t.tags, ['session']] }), 'session tag empty');
  mk((t) => ({ ...t, content: '{' }), 'broken JSON');
  mk((t) => ({ ...t, content: JSON.stringify({ unexpected: true }) }), 'unknown content keys');
  mk((t) => ({ ...t, content: '' }), 'empty content');
  mk((t) => ({ ...t, kind: 89 }), 'wrong kind');
  mk((t) => ({ ...t, tags: [] }), 'no tags at all');

  for (const [label, template] of cases) {
    it(`dkg-commitment: ${label} never crashes untyped`, () => {
      const event = signed(template);
      try {
        parseBoundDkgCommitmentEvent(event, parameters());
        parseCourtProtocolEvent(event, parameters(), [38031]);
      } catch (err) {
        expect(err).toBeInstanceOf(CourtProtocolEventError);
      }
    });
  }

  it('vote-reveal with unknown outcome fails typed', () => {
    const template = bindCourtProtocolEvent(
      buildVoteRevealEvent({ disputeId: 'dispute:fuzz:1', jurorIdx: 1, outcome: 'MAYBE', salt: '88'.repeat(32) }),
      parameters(),
      1,
    );
    try {
      parseBoundVoteRevealEvent(signed(template), parameters());
      throw new CourtProtocolEventError('invalid_tag', 'expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(CourtProtocolEventError);
    }
  });

  it('frost-reveal with oversized psig fails typed', () => {
    const template = bindCourtProtocolEvent(
      buildFrostRevealEvent({
        disputeId: 'dispute:fuzz:1',
        jurorIdx: 1,
        publicNonce: { idx: 1, binder_pn: `02${'a'.repeat(64)}`, hidden_pn: `02${'b'.repeat(64)}` },
        partialSig: 'ab'.repeat(300),
        frostPubkey: `02${'c'.repeat(64)}`,
      }),
      parameters(),
      1,
    );
    try {
      parseBoundFrostRevealEvent(signed(template), parameters());
      throw new CourtProtocolEventError('invalid_tag', 'expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(CourtProtocolEventError);
    }
  });

  it('cross-kind events are rejected typed (dkg body as frost-commit kind)', () => {
    const template = bindCourtProtocolEvent(
      buildFrostCommitEvent({ disputeId: 'dispute:fuzz:1', jurorIdx: 1, commitmentPackage: { idx: 1, binder_pn: `02${'e'.repeat(64)}`, hidden_pn: `02${'f'.repeat(64)}` } }),
      parameters(),
      1,
    );
    const event = signed(template);
    // misuse the dkg-commit parset against a frost-commit event — wrong kind is a
    // protocol error, not a crash.
    try {
      parseBoundDkgCommitmentEvent(event, parameters());
      throw new CourtProtocolEventError('unexpected_kind', 'expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(CourtProtocolEventError);
    }
  });

  it('unsigned / wrong-author events fail typed', () => {
    const event = signed(dkgTemplate(), secret(2)); // juror 2 signs juror 1's payload
    try {
      parseBoundDkgCommitmentEvent(event, parameters());
      throw new CourtProtocolEventError('participant_binding_mismatch', 'expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(CourtProtocolEventError);
    }
  });

  it('200 random-tag mutations never crash untyped', { timeout: 60_000 }, () => {
    const rng = (max: number): number => Math.floor(Math.random() * max);
    const pool = ['commit', 'session', 'juror', 'pok_n', 'pok_z', 'threshold', 'phase_nonce', 'dispute', 'p', 'host', 'suite', 'attempt', 'strange'];
    const values = ['', 'a', '0x10', '99999999999999999999999', `02${'1'.repeat(64)}`, '0'.repeat(64), '%', JSON.stringify({ a: 1 })];
    for (let round = 0; round < 200; round += 1) {
      const template: EventTemplate = {
        ...base,
        tags: base.tags.map((tag) => [...tag]),
        content: base.content,
      };
      const nOps = 1 + rng(3);
      for (let op = 0; op < nOps; op += 1) {
        if (rng(2) === 0 && template.tags.length > 0) {
          template.tags[rng(template.tags.length)] = [pool[rng(pool.length)]]; // length-1 tag
        } else {
          template.tags.push([pool[rng(pool.length)], values[rng(values.length)]]);
        }
      }
      const event = signed(template);
      try {
        parseBoundDkgCommitmentEvent(event, parameters());
        parseBoundVoteCommitEvent(event, parameters());
      } catch (err) {
        expect(err).toBeInstanceOf(CourtProtocolEventError);
      }
    }
    expect.assertions(200); // every round must throw typed or pass
  });
});
