// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import {
  COURT_SESSION_DOMAIN,
  CourtSessionValidationError,
  assertCourtParticipantBinding,
  assertCourtSessionParameters,
  encodeCourtSessionParameters,
  getCourtSessionParticipant,
  hashCourtSessionParameters,
  type CourtSessionParameters,
} from '../courtSession';

function key(byte: number): string {
  const secret = new Uint8Array(32);
  secret[31] = byte;
  return bytesToHex(secp256k1.getPublicKey(secret, true));
}

function parameters(): CourtSessionParameters {
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: 'pedpop-v1-experimental',
    disputeEventId: '11'.repeat(32),
    disputeId: 'dispute:market-2140:1',
    marketId: 'market-2140',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_000,
    participants: [
      {
        idx: 1,
        nostrPubkey: 'aa'.repeat(32),
        hostPubkey: key(1),
        bondRef: 'signet:bond:one',
        role: 'juror-coordinator',
      },
      {
        idx: 2,
        nostrPubkey: 'bb'.repeat(32),
        hostPubkey: key(2),
        bondRef: 'signet:bond:two',
        role: 'juror',
      },
      {
        idx: 3,
        nostrPubkey: 'cc'.repeat(32),
        hostPubkey: key(3),
        bondRef: 'signet:bond:three',
        role: 'juror',
      },
    ],
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 0,
    createdAt: 1_787_000_000,
    deadline: 1_787_003_600,
  };
}

function expectCode(run: () => unknown, code: CourtSessionValidationError['code']): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CourtSessionValidationError);
    expect((error as CourtSessionValidationError).code).toBe(code);
  }
}

describe('Court session parameters', () => {
  it('has a pinned canonical encoding and session hash', () => {
    const value = parameters();

    expect(COURT_SESSION_DOMAIN).toBe('BAO-Court/SessionParameters/v1');
    expect(bytesToHex(encodeCourtSessionParameters(value))).toMatchInlineSnapshot(`"01010000000020111111111111111111111111111111111111111111111111111111111111111100000015646973707574653a6d61726b65742d323134303a310000000b6d61726b65742d32313430000000202222222222222222222222222222222222222222222222222222222222222222000000203333333333333333333333333333333333333333333333333333333333333333000000204444444444444444444444444444444444444444444444444444444444444444000000000003d090000000030000000100000020aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f817980000000f7369676e65743a626f6e643a6f6e65010000000200000020bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0000002102c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee50000000f7369676e65743a626f6e643a74776f000000000300000020cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc0000002102f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9000000117369676e65743a626f6e643a746872656500000000020000000200000003594553000000024e4f00000000000000006a8374c0000000006a8382d0"`);
    expect(hashCourtSessionParameters(value)).toBe(
      'd9458c3b86582743ed8538d7aeec3560f9669068f68ab640aabb58e30ab98a8d',
    );
    expect(hashCourtSessionParameters(structuredClone(value))).toBe(
      hashCourtSessionParameters(value),
    );
  });

  it.each([
    ['environment', (value: CourtSessionParameters) => ({ ...value, environment: 'demo' as const })],
    ['suite', (value: CourtSessionParameters) => ({ ...value, cryptoSuite: 'chilldkg-0.3+bip445-draft' as const })],
    ['dispute event', (value: CourtSessionParameters) => ({ ...value, disputeEventId: '12'.repeat(32) })],
    ['dispute id', (value: CourtSessionParameters) => ({ ...value, disputeId: `${value.disputeId}:changed` })],
    ['market id', (value: CourtSessionParameters) => ({ ...value, marketId: `${value.marketId}:changed` })],
    ['market event', (value: CourtSessionParameters) => ({ ...value, marketEventId: '23'.repeat(32) })],
    ['selection event', (value: CourtSessionParameters) => ({ ...value, selectionEventId: '34'.repeat(32) })],
    ['block hash', (value: CourtSessionParameters) => ({ ...value, blockHash: '45'.repeat(32) })],
    ['block height', (value: CourtSessionParameters) => ({ ...value, blockHeight: value.blockHeight + 1 })],
    ['roster order', (value: CourtSessionParameters) => ({
      ...value,
      participants: value.participants.map((participant, offset) => ({
        ...value.participants[value.participants.length - 1 - offset],
        idx: participant.idx,
        role: participant.role,
      })),
    })],
    ['threshold', (value: CourtSessionParameters) => ({ ...value, threshold: 3 })],
    ['outcome', (value: CourtSessionParameters) => ({ ...value, allowedOutcomes: ['YES', 'DRAW'] })],
    ['outcome order', (value: CourtSessionParameters) => ({ ...value, allowedOutcomes: ['NO', 'YES'] })],
    ['attempt', (value: CourtSessionParameters) => ({ ...value, attempt: 1 })],
    ['created time', (value: CourtSessionParameters) => ({ ...value, createdAt: value.createdAt + 1 })],
    ['deadline', (value: CourtSessionParameters) => ({ ...value, deadline: value.deadline + 1 })],
  ])('changes the hash when %s changes', (_label, mutate) => {
    const value = parameters();
    expect(hashCourtSessionParameters(mutate(value))).not.toBe(hashCourtSessionParameters(value));
  });

  it('uses length prefixes instead of ambiguous delimiters', () => {
    const first = parameters();
    const second = { ...parameters(), disputeId: 'dispute', marketId: 'market-2140:1:market-2140' };

    expect(hashCourtSessionParameters(first)).not.toBe(hashCourtSessionParameters(second));
    expectCode(
      () => assertCourtSessionParameters({ ...first, disputeId: 'e\u0301' }),
      'invalid_identifier',
    );
    expectCode(
      () => assertCourtSessionParameters({ ...first, disputeId: ' dispute:market-2140:1' }),
      'invalid_identifier',
    );
  });

  it('rejects malformed keys, indices, duplicate identities, and duplicate bonds', () => {
    const value = parameters();
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant, index) => (
          index === 1 ? { ...participant, idx: 3 } : participant
        )),
      }),
      'invalid_participant_index',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant, index) => (
          index === 1 ? { ...participant, nostrPubkey: value.participants[0].nostrPubkey } : participant
        )),
      }),
      'duplicate_participant_key',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant, index) => (
          index === 1 ? { ...participant, hostPubkey: value.participants[0].hostPubkey } : participant
        )),
      }),
      'duplicate_participant_key',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant, index) => (
          index === 1 ? { ...participant, hostPubkey: `02${'00'.repeat(32)}` } : participant
        )),
      }),
      'invalid_participant_key',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant, index) => (
          index === 1 ? { ...participant, bondRef: value.participants[0].bondRef } : participant
        )),
      }),
      'duplicate_bond',
    );
  });

  it('requires one coordinator, a valid threshold, outcomes, and deadline', () => {
    const value = parameters();
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant) => ({ ...participant, role: 'juror' })),
      }),
      'invalid_coordinator_count',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant) => ({
          ...participant,
          role: 'juror-coordinator',
        })),
      }),
      'invalid_coordinator_count',
    );
    expectCode(() => assertCourtSessionParameters({ ...value, threshold: 4 }), 'invalid_threshold');
    expectCode(
      () => assertCourtSessionParameters({ ...value, allowedOutcomes: ['YES'] }),
      'invalid_outcome',
    );
    expectCode(
      () => assertCourtSessionParameters({ ...value, allowedOutcomes: ['YES', 'YES'] }),
      'duplicate_outcome',
    );
    expectCode(
      () => assertCourtSessionParameters({ ...value, deadline: value.createdAt }),
      'invalid_deadline',
    );
  });

  it('rejects unknown versions, suites, environments, and extra fields', () => {
    const value = parameters();
    expectCode(
      () => assertCourtSessionParameters({ ...value, version: 2 }),
      'unsupported_version',
    );
    expectCode(
      () => assertCourtSessionParameters({ ...value, environment: 'testnet' }),
      'unsupported_environment',
    );
    expectCode(
      () => assertCourtSessionParameters({ ...value, cryptoSuite: 'frost-ish' }),
      'unsupported_suite',
    );
    expectCode(
      () => assertCourtSessionParameters({ ...value, ignoredByHash: 'dangerous' }),
      'invalid_shape',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        participants: value.participants.map((participant, index) => (
          index === 1 ? { ...participant, ignoredByHash: 'dangerous' } : participant
        )),
      }),
      'invalid_shape',
    );
  });

  it('blocks every experimental suite on mainnet', () => {
    const value = parameters();
    expectCode(
      () => assertCourtSessionParameters({ ...value, environment: 'mainnet' }),
      'suite_not_allowed_on_mainnet',
    );
    expectCode(
      () => assertCourtSessionParameters({
        ...value,
        environment: 'mainnet',
        cryptoSuite: 'chilldkg-0.3+bip445-draft',
      }),
      'suite_not_allowed_on_mainnet',
    );
  });

  it('binds the signed Nostr author and host key to the claimed roster index', () => {
    const value = parameters();
    const participant = getCourtSessionParticipant(value, 2);

    expect(
      assertCourtParticipantBinding(value, 2, participant.nostrPubkey, participant.hostPubkey),
    ).toEqual(participant);
    expectCode(
      () => assertCourtParticipantBinding(value, 2, value.participants[0].nostrPubkey),
      'participant_binding_mismatch',
    );
    expectCode(
      () => assertCourtParticipantBinding(value, 2, participant.nostrPubkey, value.participants[0].hostPubkey),
      'participant_binding_mismatch',
    );
    expectCode(
      () => assertCourtParticipantBinding(value, 4, participant.nostrPubkey),
      'participant_not_found',
    );
  });
});
