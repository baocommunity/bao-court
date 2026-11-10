// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_MESSAGE_DOMAIN_V2,
  ATTESTATION_V2_FIELD_TAGS,
  buildAttestationMessage,
  buildAttestationMessageV2,
} from '../crypto';
import { CanonicalWriter } from '../courtSession';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hexId as hex } from './helpers/ids';

function manualV2(fields: {
  marketId: string;
  outcome: string;
  round: string;
  disputeEventId?: string;
  verdictHash?: string;
  extensions: Array<readonly [number, (w: CanonicalWriter) => void]>;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(0x02);
  writer.text(ATTESTATION_MESSAGE_DOMAIN_V2);
  writer.text(fields.marketId);
  writer.text(fields.outcome);
  writer.text(fields.round);
  if (fields.disputeEventId !== undefined) {
    writer.u8(1);
    writer.text(fields.disputeEventId);
  } else {
    writer.u8(0);
  }
  if (fields.verdictHash !== undefined) {
    writer.u8(1);
    writer.hex(fields.verdictHash);
  } else {
    writer.u8(0);
  }
  writer.u8(fields.extensions.length);
  for (const [tag, write] of fields.extensions) {
    writer.u8(tag);
    write(writer);
  }
  return bytesToHex(sha256(writer.finish()));
}

describe('buildAttestationMessageV2', () => {
  it('matches an independent canonical recomputation (no extensions)', () => {
    const expected = manualV2({
      marketId: 'm1',
      outcome: 'YES',
      round: '3',
      extensions: [],
    });
    expect(
      buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 3 }),
    ).toBe(expected);
  });

  it('encodes the full finality binding with every extension present', () => {
    const expected = manualV2({
      marketId: 'm1',
      outcome: 'NO',
      round: '2',
      disputeEventId: hex('a'),
      verdictHash: hex('b'),
      extensions: [
        [ATTESTATION_V2_FIELD_TAGS.epochId, (w) => w.u32(14)],
        [ATTESTATION_V2_FIELD_TAGS.tier, (w) => w.u8(5)],
        [ATTESTATION_V2_FIELD_TAGS.threshold, (w) => w.u32(135)],
        [ATTESTATION_V2_FIELD_TAGS.signerSetRoot, (w) => w.hex(hex('c'))],
        [ATTESTATION_V2_FIELD_TAGS.attempt, (w) => w.u32(2)],
        [ATTESTATION_V2_FIELD_TAGS.batchMerkleRoot, (w) => w.hex(hex('d'))],
      ],
    });
    expect(
      buildAttestationMessageV2({
        marketId: 'm1',
        outcome: 'NO',
        round: 2,
        disputeEventId: hex('a'),
        verdictHash: hex('b'),
        epochId: 14,
        tier: 5,
        threshold: 135,
        signerSetRoot: hex('c'),
        attempt: 2,
        batchMerkleRoot: hex('d'),
      }),
    ).toBe(expected);
  });

  it('is deterministic and differs when any finality field differs', () => {
    const base = {
      marketId: 'm1',
      outcome: 'YES',
      round: 1,
      epochId: 14,
      tier: 0,
      threshold: 3,
      signerSetRoot: hex('c'),
      attempt: 1,
    };
    const a = buildAttestationMessageV2(base);
    expect(buildAttestationMessageV2(base)).toBe(a);
    // Replay defense: every binding field changes the digest.
    expect(buildAttestationMessageV2({ ...base, epochId: 15 })).not.toBe(a);
    expect(buildAttestationMessageV2({ ...base, tier: 1 })).not.toBe(a);
    expect(buildAttestationMessageV2({ ...base, threshold: 4 })).not.toBe(a);
    expect(buildAttestationMessageV2({ ...base, signerSetRoot: hex('e') })).not.toBe(a);
    expect(buildAttestationMessageV2({ ...base, attempt: 2 })).not.toBe(a);
    expect(buildAttestationMessageV2({ ...base, batchMerkleRoot: hex('f') })).not.toBe(a);
    // And omitting a field differs from including it.
    const { threshold: _t, ...withoutThreshold } = base;
    expect(buildAttestationMessageV2(withoutThreshold)).not.toBe(a);
  });

  it('diverges from the v1 message for identical core fields', () => {
    const v1 = buildAttestationMessage('m1', 'YES', 3, hex('a'), hex('b'));
    const v2 = buildAttestationMessageV2({
      marketId: 'm1',
      outcome: 'YES',
      round: 3,
      disputeEventId: hex('a'),
      verdictHash: hex('b'),
    });
    expect(v1).not.toBe(v2);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed field values fail-closed', () => {
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, disputeEventId: 'zz' })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, verdictHash: 'zz' })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, signerSetRoot: 'zz' })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, batchMerkleRoot: 'zz' })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, epochId: -1 })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, epochId: 2 ** 32 })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, tier: 256 })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, threshold: 1.5 })).toThrow();
    expect(() => buildAttestationMessageV2({ marketId: 'm1', outcome: 'YES', round: 1, attempt: -3 })).toThrow();
  });
});
