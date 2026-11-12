// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { generateFrostKeys } from '../dkg';
import {
  aggregateAttestation,
  createCommitments,
  createRevealsAndPartialSigs,
} from '../signing';
import { buildAttestationMessage } from '../crypto';
import {
  AttributionError,
  buildSigningJournal,
  hashSigningJournal,
  verifyAggregateAttribution,
  type SigningJournal,
} from '../attribution';
import type { SelectedJuror } from '../types';

import { juror as makeJuror } from './helpers/fixtures';

const COORDS = { marketId: 'demo-market', outcome: 'YES', round: 1 } as const;

/** A complete 2-of-3 session over signers [1, 2]. */
function signSession(signers: number[] = [1, 2]) {
  const jurors: SelectedJuror[] = [makeJuror(1), makeJuror(2), makeJuror(3)];
  const { record, shares } = generateFrostKeys({
    marketId: COORDS.marketId,
    disputeId: 'a'.repeat(64),
    threshold: 2,
    jurors,
  });
  const subset = shares.filter((s) => signers.includes(s.idx));
  const params = { ...COORDS, dkg: record, shares: subset };
  const commitments = createCommitments(subset);
  const partials = createRevealsAndPartialSigs(params, commitments);
  const aggregate = aggregateAttestation(params, commitments, partials);
  const message = buildAttestationMessage(COORDS.marketId, COORDS.outcome, COORDS.round);
  return { record, shares, params, commitments, partials, aggregate, message };
}

function journalFor(session: ReturnType<typeof signSession>, signerSet = [1, 2]): SigningJournal {
  return buildSigningJournal({
    message: session.message,
    groupPubkey: session.record.groupPubkey,
    threshold: 2,
    signerSet,
    commitments: session.commitments,
    partials: session.partials,
  });
}

function clone(journal: SigningJournal): SigningJournal {
  return JSON.parse(JSON.stringify(journal)) as SigningJournal;
}

const aggregateOf = (journal: SigningJournal) => journal.aggregate;

describe('FROST aggregate attribution', () => {
  it('builds a journal that verifies and attributes both signers', () => {
    const session = signSession();
    const journal = journalFor(session);

    expect(journal.aggregate.signature).toBe(session.aggregate.signature);
    expect(journal.aggregate.pubNonce).toBe(session.aggregate.pubNonce);
    expect(hashSigningJournal(journal)).toBe(hashSigningJournal(journalFor(session)));

    const result = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
      session.record.verificationShares,
    );
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.identityPinned).toBe(true);
    expect(result.attributed).toEqual([1, 2]);
    expect(result.reconstructedSignature).toBe(session.aggregate.signature);
  });

  it('attributes a forged partial to its signer index', () => {
    const session = signSession();
    const journal = clone(journalFor(session));
    const forged = castMutable(journal).partials[0]!;
    forged.psig = `${forged.psig.slice(0, 62)}${forged.psig.endsWith('00') ? '01' : '00'}`;

    const result = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
      session.record.verificationShares,
    );
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: 'PARTIAL_INVALID', idx: forged.idx }),
    );
    expect(result.attributed).not.toContain(forged.idx);
    expect(result.attributed).toContain(forged.idx === 1 ? 2 : 1);
  });

  it('fails reconstruction when a partial is missing', () => {
    const session = signSession();
    const journal = clone(journalFor(session));
    castMutable(journal).partials.pop();

    const result = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
      session.record.verificationShares,
    );
    expect(result.valid).toBe(false);
    expect(result.reconstructedSignature).toBeNull();
    expect(result.failures.map((f) => f.code)).toContain('STRUCTURE');
  });

  it('rejects a signature the published partials do not reconstruct', () => {
    const session = signSession();
    const journal = journalFor(session);
    const agg = aggregateOf(journal);
    // Flip the final byte — never OVERWRITE it with a constant. `...ff` is a
    // NO-OP whenever the signature already ends in `ff` (1 run in 256): the
    // "tampered" aggregate then verifies and this test fails with
    // `expected true to be false`. Observed once in three loaded full-suite
    // runs on 2026-11-12; see docs/TEST_DETERMINISM.md rule 5 (a tamper must be
    // a tamper by construction).
    const lastByte = agg.signature.slice(-2);
    const flipped = (Number.parseInt(lastByte, 16) ^ 0xff).toString(16).padStart(2, '0');
    expect(flipped).not.toBe(lastByte); // the tamper always changes something
    const tampered = { ...agg, signature: `${agg.signature.slice(0, -2)}${flipped}` };

    const result = verifyAggregateAttribution(
      journal,
      tampered,
      session.record.groupPubkeyXOnly,
      session.record.verificationShares,
    );
    expect(result.valid).toBe(false);
    expect(result.failures.map((f) => f.code)).toEqual(
      expect.arrayContaining(['RECONSTRUCTION_MISMATCH', 'AGGREGATE_INVALID']),
    );
  });

  it('rejects a wrong signer set', () => {
    const session = signSession();
    // Claiming signer 3 without its commitment/partial is rejected at build time.
    expect(() => journalFor(session, [1, 2, 3])).toThrow(AttributionError);

    // Forging the published set post-hoc fails verification.
    const journal = clone(journalFor(session));
    castMutable(journal).signers[1]!.idx = 3;
    const result = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
      session.record.verificationShares,
    );
    expect(result.valid).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('STRUCTURE');
  });

  it('requires the certified verification shares (identity pin)', () => {
    const session = signSession();
    const other = signSession([1, 3]);
    const journal = journalFor(session);

    const unpinned = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
    );
    expect(unpinned.valid).toBe(true);
    expect(unpinned.identityPinned).toBe(false);

    const mismatched = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
      other.record.verificationShares,
    );
    expect(mismatched.valid).toBe(false);
    expect(mismatched.failures).toContainEqual(
      expect.objectContaining({ code: 'SHARE_MISMATCH', idx: 1 }),
    );
  });

  it('rejects a journal bound to a different group key', () => {
    const session = signSession();
    const other = signSession();
    const journal = journalFor(session);
    const result = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      other.record.groupPubkeyXOnly,
    );
    expect(result.valid).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain('GROUP_KEY_MISMATCH');
  });

  it('never throws on a malformed record (fail-closed)', () => {
    const session = signSession();
    const journal = clone(journalFor(session));
    const broken = castMutable(journal);
    broken.signers[0]!.binderPn = 'not-a-point';
    broken.partials[1]!.psig = 'zz';

    const result = verifyAggregateAttribution(
      journal,
      aggregateOf(journal),
      session.record.groupPubkeyXOnly,
      session.record.verificationShares,
    );
    expect(result.valid).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});

/** Test-only mutable view of the frozen record (tamper simulation). */
function castMutable(journal: SigningJournal): {
  signers: { idx: number; binderPn: string }[];
  partials: { idx: number; psig: string }[];
} {
  return journal as unknown as {
    signers: { idx: number; binderPn: string }[];
    partials: { idx: number; psig: string }[];
  };
}
