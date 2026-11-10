// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Nostr event builders for the BAO Court / FROST appeal protocol.
 *
 * These functions construct event templates compatible with nostr-tools,
 * nostrify, and useNostrPublish. Callers must finalize and broadcast the
 * returned templates.
 *
 * Module layout (complexity pass — one coherent seam each):
 *   - `eventsCommon.ts`  kind numbers, shared shapes and tag helpers.
 *   - `eventsParse.ts`   parsers/validators (fail-closed counterparts).
 *   - this file          builders + the public surface re-exported unchanged.
 *
 * Purity: pure functions; builders return unsigned `EventTemplate`s, no I/O.
 */

import { CourtArgumentError } from './errors';
import type { EventTemplate } from 'nostr-tools/pure';
import type { FrostAttestation, JurorProfile, StakeCommitment } from './types';
import type { DkgProofOfKnowledge } from './crypto';
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
  MAX_EVIDENCE_HASHES,
  MAX_SUPPORTING_IDS,
  nowSeconds,
  dTag,
} from './eventsCommon';
// Shared kinds/helpers live in `eventsCommon.ts`; the full public surface is
// re-exported below so every existing `./events` import keeps resolving.

interface DisputeEventParams {
  readonly marketId: string;
  readonly marketEventId?: string;
  readonly disputeId: string;
  readonly originalOutcome: string;
  readonly proposedOutcome: string;
  readonly challengerPubkey: string;
  readonly evidenceHashes: readonly string[];
  readonly disputeDeadline: number; // unix seconds
  readonly publisherPubkey?: string;
}

interface JurorCandidacyParams {
  readonly disputeId: string;
  readonly marketId: string;
  readonly juror: JurorProfile;
  readonly bondAmountSats: number;
  readonly bondAddress: string;
  readonly bondTxid?: string;
  readonly bondVout?: number;
  readonly bondScriptPubKey?: string;
  readonly deadlineSeconds?: number;
  readonly publisherPubkey?: string;
}

interface SelectionEventParams {
  readonly disputeId: string;
  readonly marketId: string;
  readonly selectedJurors: readonly { idx: number; pubkey: string; stake: number }[];
  readonly backupJurors: readonly { idx: number; pubkey: string; stake: number }[];
  readonly seed: string;
  readonly blockHash: string;
  readonly publisherPubkey?: string;
}

interface DkgCommitmentParams {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly jurorPubkey: string;
  readonly threshold: number;
  readonly vssCommits: readonly string[]; // polynomial commitments
  readonly pok: DkgProofOfKnowledge; // proof of knowledge of constant coefficient
  /** Round-scoped nonce binding encrypted shares to this commitment. */
  readonly phaseNonce: string;
}

interface VoteCommitParams {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly commitHash: string; // SHA256(outcome || salt)
  readonly publisherPubkey?: string;
}

interface VoteRevealParams {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly outcome: string;
  readonly salt: string;
  readonly publisherPubkey?: string;
}

interface FrostCommitParams {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly commitmentPackage: {
    idx: number;
    binder_pn: string;
    hidden_pn: string;
  };
  readonly publisherPubkey?: string;
}

interface FrostRevealParams {
  readonly disputeId: string;
  readonly jurorIdx: number;
  readonly publicNonce: {
    idx: number;
    binder_pn: string;
    hidden_pn: string;
  };
  readonly partialSig: string;
  /** Compressed FROST verification pubkey for this juror (33-byte hex). */
  readonly frostPubkey: string;
  readonly publisherPubkey?: string;
}

/**
 * Build the Kind 38025 dispute-open event template.
 *
 * Sorts the evidence hashes canonically (lowercase, ascending) so the
 * template is byte-deterministic for a given logical input regardless of
 * insertion order.
 *
 * @param params - dispute coordinates; `evidenceHashes` is capped at 64.
 * @returns An unsigned `EventTemplate` (kind 38025). Callers finalize with
 *          their signer and broadcast; this function does no I/O.
 * @throws {@link CourtArgumentError} code `NOSTR_EVENT_ARGUMENT` when
 *         `evidenceHashes.length > 64`.
 *
 * @example
 * ```ts
 * const tpl = buildDisputeEvent({
 *   marketId, disputeId: crypto.randomUUID(),
 *   originalOutcome: 'YES', proposedOutcome: 'NO',
 *   challengerPubkey, evidenceHashes: [sha256Hex(evidence)],
 *   disputeDeadline: Math.floor(Date.now() / 1000) + 86400,
 * });
 * await pool.publish(relays, finalizeEvent(tpl, sk));
 * ```
 */
export function buildDisputeEvent(params: DisputeEventParams): EventTemplate {
  if (params.evidenceHashes.length > MAX_EVIDENCE_HASHES) {
    throw new CourtArgumentError('NOSTR_EVENT_ARGUMENT', 
      `evidenceHashes length ${params.evidenceHashes.length} exceeds maximum of ${MAX_EVIDENCE_HASHES}`,
    );
  }
  const tags: string[][] = [
    dTag(params.disputeId),
    ['e', params.marketEventId ?? params.marketId, '', 'root'],
    ['market', params.marketId],
    ['dispute', params.disputeId],
    ['original', params.originalOutcome],
    ['proposed', params.proposedOutcome],
    ['deadline', String(params.disputeDeadline)],
    ['appeal_type', 'frost'],
    // Canonicalize evidence hashes: convert to tags, lowercase, sort so the
    // event is deterministic and independent of insertion order.
    ...[...params.evidenceHashes.map((h): [string, string] => ['evidence', h.toLowerCase()])].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)),
    ['alt', `BAO Court dispute ${params.disputeId.slice(0, 12)}`],
  ];
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  if (params.challengerPubkey) {
    tags.push(['challenger', params.challengerPubkey]);
  }
  return {
    kind: BAO_COURT_DISPUTE_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      marketId: params.marketId,
      marketEventId: params.marketEventId,
      disputeId: params.disputeId,
      originalOutcome: params.originalOutcome,
      proposedOutcome: params.proposedOutcome,
      evidenceHashes: params.evidenceHashes,
    }),
  };
}

/**
 * Build the Kind 39001 juror-candidacy (bond pledge) event template.
 *
 * Embeds the candidate's profile and bond evidence (amount, address, and
 * optional txid/vout/script/deadline) in both tags and JSON content.
 *
 * @returns An unsigned `EventTemplate` (kind 39001); no I/O, no signing.
 */
export function buildJurorCandidacyEvent(
  params: JurorCandidacyParams,
): EventTemplate {
  const tags: string[][] = [
    dTag(params.disputeId),
    ['e', params.disputeId, '', 'root'],
    ['dispute', params.disputeId],
    ['market', params.marketId],
    ['bond', String(params.bondAmountSats)],
    ['address', params.bondAddress],
    ['alt', `BAO Court juror candidacy for dispute ${params.disputeId.slice(0, 12)}`],
  ];
  if (params.bondTxid) {
    tags.push(['bondTxid', params.bondTxid]);
  }
  if (params.bondVout !== undefined) {
    tags.push(['bondVout', String(params.bondVout)]);
  }
  if (params.bondScriptPubKey) {
    tags.push(['bondScript', params.bondScriptPubKey]);
  }
  if (params.deadlineSeconds !== undefined) {
    tags.push(['deadline', String(params.deadlineSeconds)]);
  }
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  for (const category of params.juror.categories) {
    tags.push(['t', category]);
  }

  return {
    kind: BAO_COURT_JUROR_CANDIDACY_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      marketId: params.marketId,
      disputeId: params.disputeId,
      stakeCapacitySats: params.juror.stakeCapacitySats,
      wotScore: params.juror.wotScore,
      categories: params.juror.categories,
      registeredAt: params.juror.registeredAt,
      bondAmountSats: params.bondAmountSats,
      bondAddress: params.bondAddress,
      bondTxid: params.bondTxid,
      bondVout: params.bondVout,
      bondScriptPubKey: params.bondScriptPubKey,
      deadlineSeconds: params.deadlineSeconds,
    }),
  };
}

/**
 * Build the Kind 39002 jury-selection event template.
 *
 * Publishes the deterministic draw outcome: seed, anchor block hash, and the
 * selected + backup juror rosters. Observers re-run
 * {@link verifyJurySelection} against these fields.
 *
 * @returns An unsigned `EventTemplate` (kind 39002); no I/O, no signing.
 */
export function buildSelectionEvent(
  params: SelectionEventParams,
): EventTemplate {
  const tags: string[][] = [
    dTag(params.disputeId),
    ['e', params.disputeId, '', 'root'],
    ['dispute', params.disputeId],
    ['market', params.marketId],
    ['seed', params.seed],
    ['block', params.blockHash],
    ...params.selectedJurors.map((j): [string, string, string, string] => [
      'selected',
      String(j.idx),
      j.pubkey,
      String(j.stake),
    ]),
    ...params.backupJurors.map((j): [string, string, string, string] => [
      'backup',
      String(j.idx),
      j.pubkey,
      String(j.stake),
    ]),
    ['alt', `BAO Court jury selection for dispute ${params.disputeId.slice(0, 12)}`],
  ];
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  return {
    kind: BAO_COURT_SELECTION_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      marketId: params.marketId,
      disputeId: params.disputeId,
      seed: params.seed,
      blockHash: params.blockHash,
      selected: params.selectedJurors,
      backups: params.backupJurors,
    }),
  };
}

/**
 * Build the Kind 38031 DKG-commitment event template for one juror.
 *
 * Carries the VSS polynomial commitments, threshold, phase nonce, and the
 * Schnorr proof of knowledge of the juror's secret polynomial share.
 *
 * @returns An unsigned `EventTemplate` (kind 38031); no I/O, no signing.
 */
export function buildDkgCommitmentEvent(
  params: DkgCommitmentParams,
): EventTemplate {
  return {
    kind: BAO_COURT_DKG_COMMITMENT_KIND,
    created_at: nowSeconds(),
    tags: [
      dTag(params.disputeId, params.jurorIdx),
      ['e', params.disputeId, '', 'root'],
      ['p', params.jurorPubkey],
      ['dispute', params.disputeId],
      ['juror', String(params.jurorIdx)],
      ['threshold', String(params.threshold)],
      ['phase_nonce', params.phaseNonce],
      ['pok_n', params.pok.nonce],
      ['pok_z', params.pok.response],
      ...params.vssCommits.map((c): [string, string] => ['commit', c]),
      ['alt', `BAO Court DKG commitment from juror ${params.jurorIdx}`],
    ],
    content: JSON.stringify({
      disputeId: params.disputeId,
      jurorIdx: params.jurorIdx,
      threshold: params.threshold,
      phaseNonce: params.phaseNonce,
      pok: params.pok,
      vssCommits: params.vssCommits,
    }),
  };
}

/**
 * Build the Kind 39004 vote-commit event template for one juror.
 *
 * Publishes `commitHash = H(outcome ‖ salt)` (domain
 * {@link COURT_VOTE_COMMIT_DOMAIN}); the matching reveal is a Kind 39014.
 *
 * @returns An unsigned `EventTemplate` (kind 39004); no I/O, no signing.
 */
export function buildVoteCommitEvent(params: VoteCommitParams): EventTemplate {
  const tags: string[][] = [
    dTag(params.disputeId, params.jurorIdx),
    ['e', params.disputeId, '', 'root'],
    ['dispute', params.disputeId],
    ['juror', String(params.jurorIdx)],
    ['commit', params.commitHash],
    ['alt', `BAO Court vote commit from juror ${params.jurorIdx}`],
  ];
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  return {
    kind: BAO_COURT_VOTE_COMMIT_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      disputeId: params.disputeId,
      jurorIdx: params.jurorIdx,
      commitHash: params.commitHash,
    }),
  };
}

/**
 * Build the Kind 39014 vote-reveal event template for one juror.
 *
 * Publishes the plaintext outcome and salt; verifiers check
 * `hashCommit(outcome, salt) === commitHash` from the earlier commit event.
 *
 * @returns An unsigned `EventTemplate` (kind 39014); no I/O, no signing.
 */
export function buildVoteRevealEvent(params: VoteRevealParams): EventTemplate {
  const tags: string[][] = [
    dTag(params.disputeId, params.jurorIdx),
    ['e', params.disputeId, '', 'root'],
    ['dispute', params.disputeId],
    ['juror', String(params.jurorIdx)],
    ['outcome', params.outcome],
    ['salt', params.salt],
    ['alt', `BAO Court vote reveal from juror ${params.jurorIdx}`],
  ];
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  return {
    kind: BAO_COURT_VOTE_REVEAL_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      disputeId: params.disputeId,
      jurorIdx: params.jurorIdx,
      outcome: params.outcome,
      salt: params.salt,
    }),
  };
}

/**
 * Build the Kind 39005 FROST signing-commitment event template for one juror.
 *
 * Publishes the binder/hidden public-nonce package from the FROST round-1
 * commitment; the matching partial signature is a Kind 39006 reveal.
 *
 * @returns An unsigned `EventTemplate` (kind 39005); no I/O, no signing.
 */
export function buildFrostCommitEvent(
  params: FrostCommitParams,
): EventTemplate {
  const tags: string[][] = [
    dTag(params.disputeId, params.jurorIdx),
    ['e', params.disputeId, '', 'root'],
    ['dispute', params.disputeId],
    ['juror', String(params.jurorIdx)],
    ['binder_pn', params.commitmentPackage.binder_pn],
    ['hidden_pn', params.commitmentPackage.hidden_pn],
    ['alt', `BAO Court FROST signing commitment from juror ${params.jurorIdx}`],
  ];
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  return {
    kind: BAO_COURT_FROST_COMMIT_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      disputeId: params.disputeId,
      jurorIdx: params.jurorIdx,
      commitmentPackage: params.commitmentPackage,
    }),
  };
}

/**
 * Build the Kind 39006 FROST signing-reveal event template for one juror.
 *
 * Publishes the public nonce, the BIP-340 partial signature, and the juror's
 * FROST group-share public key.
 *
 * @returns An unsigned `EventTemplate` (kind 39006); no I/O, no signing.
 */
export function buildFrostRevealEvent(params: FrostRevealParams): EventTemplate {
  const tags: string[][] = [
    dTag(params.disputeId, params.jurorIdx),
    ['e', params.disputeId, '', 'root'],
    ['dispute', params.disputeId],
    ['juror', String(params.jurorIdx)],
    ['pk', params.frostPubkey],
    ['nonce_binder', params.publicNonce.binder_pn],
    ['nonce_hidden', params.publicNonce.hidden_pn],
    ['psig', params.partialSig],
    ['alt', `BAO Court FROST signing reveal from juror ${params.jurorIdx}`],
  ];
  if (params.publisherPubkey) {
    tags.push(['p', params.publisherPubkey]);
  }
  return {
    kind: BAO_COURT_FROST_REVEAL_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      disputeId: params.disputeId,
      jurorIdx: params.jurorIdx,
      publicNonce: params.publicNonce,
      partialSig: params.partialSig,
      frostPubkey: params.frostPubkey,
    }),
  };
}

/**
 * Build the FROST attestation event template (kind 39007, or 89 for legacy
 * compat) from a signed {@link FrostAttestation}.
 *
 * The attestation's `supportingEventIds` become `e`-tags with `mention`
 * marker: Nostr signs tags, so the event id commits to the exact reveal set
 * the verdict was tallied from. Capped at 10 000 supporting ids.
 *
 * @throws {@link CourtArgumentError} code `NOSTR_EVENT_ARGUMENT` when
 *         `supportingEventIds` exceeds 10 000 entries.
 */
export function buildDisputeAttestationEvent(
  params: {
    attestation: FrostAttestation;
    marketEventId: string;
  },
): EventTemplate {
  const { attestation, marketEventId } = params;
  const tags: string[][] = [
    dTag(attestation.disputeEventId ?? marketEventId),
    ['e', marketEventId, '', 'root'],
    ['m', attestation.marketId],
    ['p', attestation.groupPubkey],
    ['outcome', attestation.outcome],
    ['round', String(attestation.round)],
    ['nonce', attestation.pubNonce],
    ['sig', attestation.signature],
    ['ver', 'FROST-BIP340-v1'],
    ['alt', `BAO Court FROST attestation: ${attestation.outcome}`],
  ];
  if (attestation.disputeEventId) {
    tags.push(['dispute', attestation.disputeEventId]);
  }
  if (attestation.verdictHash) {
    tags.push(['verdict', attestation.verdictHash]);
  }
  // Supporting reveal event ids — the evidence the verdict commitment pins.
  // Observers recompute the tally from these and check it against the
  // `verdict` tag; the Nostr event id commits to both (tags are signed).
  const supportIds = attestation.supportingEventIds ?? [];
  if (supportIds.length > MAX_SUPPORTING_IDS) {
    throw new CourtArgumentError('NOSTR_EVENT_ARGUMENT', 
      `supportingEventIds length ${supportIds.length} exceeds maximum of ${MAX_SUPPORTING_IDS}`,
    );
  }
  for (const id of supportIds) {
    tags.push(['e', id, '', 'mention']);
  }
  return {
    kind: attestation.kind,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify({
      marketId: attestation.marketId,
      outcome: attestation.outcome,
      round: String(attestation.round),
      message: attestation.message,
      disputeEventId: attestation.disputeEventId,
      verdictHash: attestation.verdictHash,
      supportingEventIds: attestation.supportingEventIds ?? [],
    }),
  };
}

/**
 * Build a Nostr attestation event.
 *
 * Supports both the reference-script positional call style
 * `buildAttestationEvent(attestation, marketEventId)` and the object style
 * `buildAttestationEvent({ attestation, marketEventId })`.
 */
export function buildAttestationEvent(
  attestationOrParams: FrostAttestation | { attestation: FrostAttestation; marketEventId: string },
  marketEventId?: string,
): EventTemplate {
  if (marketEventId && 'signature' in attestationOrParams) {
    return buildDisputeAttestationEvent({
      attestation: attestationOrParams,
      marketEventId,
    });
  }
  if (
    typeof attestationOrParams === 'object' &&
    attestationOrParams !== null &&
    'attestation' in attestationOrParams &&
    typeof attestationOrParams.marketEventId === 'string'
  ) {
    return buildDisputeAttestationEvent(attestationOrParams);
  }
  throw new CourtArgumentError('NOSTR_EVENT_ARGUMENT', 
    'buildAttestationEvent: expected (attestation, marketEventId) or ' +
      '{ attestation, marketEventId }',
  );
}

export {
  BAO_COURT_DISPUTE_KIND,
  BAO_COURT_JUROR_CANDIDACY_KIND,
  BAO_COURT_SELECTION_KIND,
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_FROST_REVEAL_KIND,
  BAO_COURT_ATTESTATION_KIND,
} from './eventsCommon';

export {
  parseJurorCandidacyEvent,
  parseSelectionEvent,
  parseDkgCommitmentEvent,
  parseVoteCommitEvent,
  parseVoteRevealEvent,
  parseFrostCommitEvent,
  parseFrostRevealEvent,
  parseAttestationEvent,
  validateSelectionEvent,
  type SelectedJurorEntry,
  type SelectionValidationResult,
} from './eventsParse';
