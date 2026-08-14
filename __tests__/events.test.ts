// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import {
  BAO_COURT_DISPUTE_KIND,
  BAO_COURT_JUROR_CANDIDACY_KIND,
  BAO_COURT_SELECTION_KIND,
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_FROST_REVEAL_KIND,
  BAO_COURT_ATTESTATION_KIND,
  buildDisputeEvent,
  buildJurorCandidacyEvent,
  buildSelectionEvent,
  buildDkgCommitmentEvent,
  buildVoteCommitEvent,
  buildVoteRevealEvent,
  buildFrostCommitEvent,
  buildFrostRevealEvent,
  buildAttestationEvent,
  parseAttestationEvent,
  parseJurorCandidacyEvent,
  parseSelectionEvent,
  parseDkgCommitmentEvent,
  parseVoteCommitEvent,
  parseVoteRevealEvent,
  validateSelectionEvent,
} from '../events';
import type { FrostAttestation, JurorProfile } from '../types';

describe('BAO Court event builders', () => {
  it('builds a dispute event with kind 38025 and required tags', () => {
    const template = buildDisputeEvent({
      marketId: 'demo-market',
      marketEventId: 'm'.repeat(64),
      disputeId: 'd'.repeat(64),
      originalOutcome: 'YES',
      proposedOutcome: 'NO',
      challengerPubkey: 'c'.repeat(64),
      evidenceHashes: ['e'.repeat(64)],
      disputeDeadline: 1_700_000_000,
    });

    expect(template.kind).toBe(BAO_COURT_DISPUTE_KIND);
    expect(template.tags).toContainEqual(['dispute', 'd'.repeat(64)]);
    expect(template.tags).toContainEqual(['market', 'demo-market']);
    expect(template.tags).toContainEqual(['original', 'YES']);
    expect(template.tags).toContainEqual(['proposed', 'NO']);
    expect(template.tags).toContainEqual(['appeal_type', 'frost']);
    expect(template.tags).toContainEqual(['evidence', 'e'.repeat(64)]);
    expect(JSON.parse(template.content)).toMatchObject({
      marketId: 'demo-market',
      disputeId: 'd'.repeat(64),
      originalOutcome: 'YES',
      proposedOutcome: 'NO',
    });
  });

  it('builds a juror candidacy event with kind 39001', () => {
    const juror: JurorProfile = {
      nostrPubkey: 'a'.repeat(64),
      stakeCapacitySats: 100_000,
      stakeCommitment: {
        amountSats: 10_000,
        bondAddress: 'bc1q...',
        status: 'confirmed',
        committedAt: 1_700_000_000,
      },
      wotScore: 80,
      categories: ['world', 'crypto'],
      registeredAt: 1_700_000_000,
    };

    const template = buildJurorCandidacyEvent({
      disputeId: 'd'.repeat(64),
      marketId: 'demo-market',
      juror,
      bondAmountSats: 10_000,
      bondAddress: 'bc1q...',
      bondScriptPubKey: '5120' + 'a'.repeat(64),
    });

    expect(template.kind).toBe(BAO_COURT_JUROR_CANDIDACY_KIND);
    expect(template.tags).toContainEqual(['bond', '10000']);
    expect(template.tags).toContainEqual(['address', 'bc1q...']);
    expect(template.tags).toContainEqual(['bondScript', '5120' + 'a'.repeat(64)]);
    expect(template.tags).toContainEqual(['t', 'world']);
    expect(template.tags).toContainEqual(['t', 'crypto']);

    const parsed = parseJurorCandidacyEvent({ ...template, pubkey: juror.nostrPubkey, created_at: 1 });
    expect(parsed?.nostrPubkey).toBe(juror.nostrPubkey);
    expect(parsed?.stakeCapacitySats).toBe(100_000);
    expect(parsed?.categories).toEqual(['world', 'crypto']);
    expect(parsed?.stakeCommitment.scriptPubKey).toBe('5120' + 'a'.repeat(64));
    // The parser must NOT fabricate confirmation — an admission authority
    // (coordinator after verification) stamps status, never the parser.
    expect(parsed?.stakeCommitment.status).toBe('pending');
  });

  it('builds a selection event with kind 39002', () => {
    const template = buildSelectionEvent({
      disputeId: 'd'.repeat(64),
      marketId: 'demo-market',
      selectedJurors: [{ idx: 1, pubkey: 'a'.repeat(64), stake: 10_000 }],
      backupJurors: [{ idx: 2, pubkey: 'b'.repeat(64), stake: 10_000 }],
      seed: 's'.repeat(64),
      blockHash: 'h'.repeat(64),
    });

    expect(template.kind).toBe(BAO_COURT_SELECTION_KIND);
    expect(template.tags).toContainEqual(['selected', '1', 'a'.repeat(64), '10000']);
    expect(template.tags).toContainEqual(['backup', '2', 'b'.repeat(64), '10000']);

    const parsed = parseSelectionEvent(template);
    expect(parsed?.selected[0]).toEqual({ idx: 1, pubkey: 'a'.repeat(64), stake: 10_000 });
    expect(parsed?.backups[0]).toEqual({ idx: 2, pubkey: 'b'.repeat(64), stake: 10_000 });
  });

  it('uses distinct kinds for vote commit (39004) and reveal (39014)', () => {
    const commit = buildVoteCommitEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 1,
      commitHash: 'c'.repeat(64),
    });
    const reveal = buildVoteRevealEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 1,
      outcome: 'YES',
      salt: 's'.repeat(64),
    });

    expect(commit.kind).toBe(BAO_COURT_VOTE_COMMIT_KIND);
    expect(reveal.kind).toBe(BAO_COURT_VOTE_REVEAL_KIND);
    expect(BAO_COURT_VOTE_COMMIT_KIND).not.toBe(BAO_COURT_VOTE_REVEAL_KIND);
    expect(commit.tags).toContainEqual(['commit', 'c'.repeat(64)]);
    expect(reveal.tags).toContainEqual(['outcome', 'YES']);
    expect(reveal.tags).toContainEqual(['salt', 's'.repeat(64)]);

    const parsedCommit = parseVoteCommitEvent({ ...commit, pubkey: 'a'.repeat(64) });
    const parsedReveal = parseVoteRevealEvent({ ...reveal, pubkey: 'a'.repeat(64) });
    expect(parsedCommit?.commitHash).toBe('c'.repeat(64));
    expect(parsedReveal?.outcome).toBe('YES');
    expect(parsedReveal?.salt).toBe('s'.repeat(64));
  });

  it('builds a FROST commitment and reveal event', () => {
    const commit = buildFrostCommitEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 1,
      commitmentPackage: { idx: 1, binder_pn: 'b'.repeat(64), hidden_pn: 'h'.repeat(64) },
    });
    const reveal = buildFrostRevealEvent({
      disputeId: 'd'.repeat(64),
      jurorIdx: 1,
      publicNonce: { idx: 1, binder_pn: 'b'.repeat(64), hidden_pn: 'h'.repeat(64) },
      partialSig: 'p'.repeat(128),
      frostPubkey: '02' + 'f'.repeat(64),
    });

    expect(commit.kind).toBe(BAO_COURT_FROST_COMMIT_KIND);
    expect(reveal.kind).toBe(BAO_COURT_FROST_REVEAL_KIND);
    expect(commit.tags).toContainEqual(['binder_pn', 'b'.repeat(64)]);
    expect(reveal.tags).toContainEqual(['psig', 'p'.repeat(128)]);
  });

  it('builds an attestation event using the attestation kind', () => {
    const attestation: FrostAttestation = {
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      signature: 's'.repeat(128),
      pubNonce: 'n'.repeat(64),
      groupPubkey: 'g'.repeat(64),
      message: 'm'.repeat(64),
      kind: 39007,
      disputeEventId: 'd'.repeat(64),
    };

    const template = buildAttestationEvent({ attestation, marketEventId: 'e'.repeat(64) });
    expect(template.kind).toBe(BAO_COURT_ATTESTATION_KIND);
    expect(template.tags).toContainEqual(['p', 'g'.repeat(64)]);
    expect(template.tags).toContainEqual(['outcome', 'YES']);
    expect(template.tags).toContainEqual(['sig', 's'.repeat(128)]);
    expect(template.tags).toContainEqual(['dispute', 'd'.repeat(64)]);
  });

  it('parses a Kind 39007 attestation event', () => {
    const attestation: FrostAttestation = {
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      signature: 'ab'.repeat(64),
      pubNonce: 'cd'.repeat(32),
      groupPubkey: 'ef'.repeat(32),
      message: '12'.repeat(32),
      kind: 39007,
      disputeEventId: 'd'.repeat(64),
    };

    const template = buildAttestationEvent({ attestation, marketEventId: 'e'.repeat(64) });
    const parsed = parseAttestationEvent(template);
    expect(parsed).not.toBeNull();
    expect(parsed!.marketId).toBe('demo-market');
    expect(parsed!.outcome).toBe('YES');
    expect(parsed!.signature).toBe('ab'.repeat(64));
    expect(parsed!.pubNonce).toBe('cd'.repeat(32));
    expect(parsed!.groupPubkey).toBe('ef'.repeat(32));
    expect(parsed!.message).toBe('12'.repeat(32));
    expect(parsed!.kind).toBe(39007);
    expect(parsed!.disputeEventId).toBe('d'.repeat(64));
  });

  it('supports the positional buildAttestationEvent signature', () => {
    const attestation: FrostAttestation = {
      marketId: 'demo-market',
      outcome: 'YES',
      round: 1,
      signature: 's'.repeat(128),
      pubNonce: 'n'.repeat(64),
      groupPubkey: 'g'.repeat(64),
      message: 'm'.repeat(64),
      kind: 39007,
      disputeEventId: 'd'.repeat(64),
    };

    const template = buildAttestationEvent(attestation, 'e'.repeat(64));
    expect(template.kind).toBe(BAO_COURT_ATTESTATION_KIND);
    expect(template.tags).toContainEqual(['m', 'demo-market']);
  });

  it('parsers return null for malformed events', () => {
    expect(parseJurorCandidacyEvent({ kind: 1, pubkey: 'a'.repeat(64), tags: [], content: '', created_at: 0, id: 'x', sig: 'x' })).toBeNull();
    expect(parseSelectionEvent({ kind: 1, tags: [], content: '', id: 'x', pubkey: 'x', sig: 'x', created_at: 0 })).toBeNull();
    expect(parseDkgCommitmentEvent({ kind: 1, pubkey: 'a'.repeat(64), tags: [], content: '', id: 'x', sig: 'x', created_at: 0 })).toBeNull();
    expect(parseVoteCommitEvent({ kind: 1, pubkey: 'a'.repeat(64), tags: [], content: '', id: 'x', sig: 'x', created_at: 0 })).toBeNull();
    expect(parseVoteRevealEvent({ kind: 1, pubkey: 'a'.repeat(64), tags: [], content: '', id: 'x', sig: 'x', created_at: 0 })).toBeNull();
  });

  it('adds d tags scoped to dispute id', () => {
    const disputeId = 'd'.repeat(64);
    const dispute = buildDisputeEvent({
      marketId: 'demo-market',
      disputeId,
      originalOutcome: 'YES',
      proposedOutcome: 'NO',
      challengerPubkey: 'c'.repeat(64),
      evidenceHashes: [],
      disputeDeadline: 1_700_000_000,
    });
    expect(dispute.tags).toContainEqual(['d', disputeId]);

    const candidacy = buildJurorCandidacyEvent({
      disputeId,
      marketId: 'demo-market',
      juror: {
        nostrPubkey: 'a'.repeat(64),
        stakeCapacitySats: 10_000,
        stakeCommitment: { amountSats: 10_000, bondAddress: 'bc1q', status: 'confirmed' },
        wotScore: 80,
        categories: [],
        registeredAt: 1,
      },
      bondAmountSats: 10_000,
      bondAddress: 'bc1q',
    });
    expect(candidacy.tags).toContainEqual(['d', disputeId]);

    const selection = buildSelectionEvent({
      disputeId,
      marketId: 'demo-market',
      selectedJurors: [{ idx: 1, pubkey: 'a'.repeat(64), stake: 10_000 }],
      backupJurors: [],
      seed: 's'.repeat(64),
      blockHash: 'h'.repeat(64),
    });
    expect(selection.tags).toContainEqual(['d', disputeId]);

    const dkg = buildDkgCommitmentEvent({
      disputeId,
      jurorIdx: 1,
      jurorPubkey: 'a'.repeat(64),
      threshold: 2,
      vssCommits: ['c'.repeat(66)],
      pok: { nonce: 'n'.repeat(66), response: 'r'.repeat(64) },
      phaseNonce: 'p'.repeat(64),
    });
    expect(dkg.tags).toContainEqual(['d', `${disputeId}:1`]);

    const voteCommit = buildVoteCommitEvent({ disputeId, jurorIdx: 2, commitHash: 'h'.repeat(64) });
    expect(voteCommit.tags).toContainEqual(['d', `${disputeId}:2`]);

    const voteReveal = buildVoteRevealEvent({ disputeId, jurorIdx: 3, outcome: 'YES', salt: 's'.repeat(64) });
    expect(voteReveal.tags).toContainEqual(['d', `${disputeId}:3`]);

    const frostCommit = buildFrostCommitEvent({
      disputeId,
      jurorIdx: 4,
      commitmentPackage: { idx: 4, binder_pn: 'b'.repeat(64), hidden_pn: 'h'.repeat(64) },
    });
    expect(frostCommit.tags).toContainEqual(['d', `${disputeId}:4`]);

    const attestation = buildAttestationEvent({
      attestation: {
        marketId: 'demo-market',
        outcome: 'YES',
        round: 1,
        signature: 's'.repeat(128),
        pubNonce: 'n'.repeat(64),
        groupPubkey: 'g'.repeat(64),
        message: 'm'.repeat(64),
        kind: 39007,
        disputeEventId: disputeId,
      },
      marketEventId: 'e'.repeat(64),
    });
    expect(attestation.tags).toContainEqual(['d', disputeId]);
  });

  it('builds and parses a DKG commitment event with threshold and PoK', () => {
    const disputeId = 'd'.repeat(64);
    const template = buildDkgCommitmentEvent({
      disputeId,
      jurorIdx: 1,
      jurorPubkey: 'a'.repeat(64),
      threshold: 2,
      vssCommits: ['c'.repeat(66)],
      pok: { nonce: 'n'.repeat(66), response: 'r'.repeat(64) },
      phaseNonce: 'p'.repeat(64),
    });

    expect(template.kind).toBe(BAO_COURT_DKG_COMMITMENT_KIND);
    expect(template.tags).toContainEqual(['threshold', '2']);
    expect(template.tags).toContainEqual(['phase_nonce', 'p'.repeat(64)]);
    expect(template.tags).toContainEqual(['pok_n', 'n'.repeat(66)]);
    expect(template.tags).toContainEqual(['pok_z', 'r'.repeat(64)]);

    const parsed = parseDkgCommitmentEvent({ ...template, pubkey: 'a'.repeat(64) });
    expect(parsed).not.toBeNull();
    expect(parsed?.threshold).toBe(2);
    expect(parsed?.phaseNonce).toBe('p'.repeat(64));
    expect(parsed?.pok.nonce).toBe('n'.repeat(66));
    expect(parsed?.pok.response).toBe('r'.repeat(64));
  });

  it('validates selection events', () => {
    const valid = buildSelectionEvent({
      disputeId: 'd'.repeat(64),
      marketId: 'demo-market',
      selectedJurors: [{ idx: 1, pubkey: 'a'.repeat(64), stake: 10_000 }],
      backupJurors: [],
      seed: 's'.repeat(64),
      blockHash: 'h'.repeat(64),
    });

    expect(validateSelectionEvent(valid, 'd'.repeat(64)).valid).toBe(true);
    expect(validateSelectionEvent(valid, 'x'.repeat(64)).valid).toBe(false);

    const noSelected = {
      ...valid,
      tags: valid.tags.filter((t) => t[0] !== 'selected'),
    };
    expect(validateSelectionEvent(noSelected).valid).toBe(false);

    const duplicateIdx = buildSelectionEvent({
      disputeId: 'd'.repeat(64),
      marketId: 'demo-market',
      selectedJurors: [{ idx: 1, pubkey: 'a'.repeat(64), stake: 10_000 }],
      backupJurors: [{ idx: 1, pubkey: 'b'.repeat(64), stake: 10_000 }],
      seed: 's'.repeat(64),
      blockHash: 'h'.repeat(64),
    });
    expect(validateSelectionEvent(duplicateIdx).valid).toBe(false);

    const badPubkey = buildSelectionEvent({
      disputeId: 'd'.repeat(64),
      marketId: 'demo-market',
      selectedJurors: [{ idx: 1, pubkey: 'not-hex', stake: 10_000 }],
      backupJurors: [],
      seed: 's'.repeat(64),
      blockHash: 'h'.repeat(64),
    });
    expect(validateSelectionEvent(badPubkey).valid).toBe(false);
  });
});
