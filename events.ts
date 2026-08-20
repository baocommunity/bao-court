// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Nostr event builders for the BAO Court / FROST appeal protocol.
 *
 * These functions construct event templates compatible with nostr-tools,
 * nostrify, and useNostrPublish. Callers must finalize and broadcast the
 * returned templates.
 */

import type { EventTemplate, Event as NostrEvent } from 'nostr-tools/pure';
import type { FrostAttestation, JurorProfile, StakeCommitment } from './types';
import type { DkgProofOfKnowledge } from './crypto';

interface NostrEventLike {
  kind: number;
  tags: string[][];
  content: string;
  pubkey?: string;
  created_at?: number;
  id?: string;
  sig?: string;
}

export const BAO_COURT_DISPUTE_KIND = 38025;
export const BAO_COURT_JUROR_CANDIDACY_KIND = 39001;
export const BAO_COURT_SELECTION_KIND = 39002;
export const BAO_COURT_DKG_COMMITMENT_KIND = 38031;
export const BAO_COURT_VOTE_COMMIT_KIND = 39004;
export const BAO_COURT_VOTE_REVEAL_KIND = 39014;
export const BAO_COURT_FROST_COMMIT_KIND = 39005;
export const BAO_COURT_FROST_REVEAL_KIND = 39006;
export const BAO_COURT_ATTESTATION_KIND = 39007;

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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function isNostrId(value: string): boolean {
  return isHex64(value);
}

/** Parse a positive integer (valid FROST/juror index); null when invalid. */
function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function dTag(disputeId: string, suffix?: string | number): [string, string] {
  return ['d', suffix !== undefined ? `${disputeId}:${suffix}` : disputeId];
}

/** Maximum number of evidence hashes per dispute event. */
const MAX_EVIDENCE_HASHES = 64;

/** Maximum number of supporting event IDs per attestation. */
const MAX_SUPPORTING_IDS = 10_000;

export function buildDisputeEvent(params: DisputeEventParams): EventTemplate {
  if (params.evidenceHashes.length > MAX_EVIDENCE_HASHES) {
    throw new Error(
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

export function parseJurorCandidacyEvent(
  event: NostrEventLike,
): JurorProfile | null {
  if (event.kind !== BAO_COURT_JUROR_CANDIDACY_KIND || !event.pubkey || !isNostrId(event.pubkey)) {
    return null;
  }

  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const bondTag = event.tags.find((t) => t[0] === 'bond');
    const addressTag = event.tags.find((t) => t[0] === 'address');
    const txidTag = event.tags.find((t) => t[0] === 'bondTxid');
    const voutTag = event.tags.find((t) => t[0] === 'bondVout');
    const scriptTag = event.tags.find((t) => t[0] === 'bondScript');
    const deadlineTag = event.tags.find((t) => t[0] === 'deadline');
    const categoryTags = event.tags.filter((t) => t[0] === 't').map((t) => t[1]);

    const amountSats = Number(bondTag?.[1] ?? content.bondAmountSats ?? 0);
    const bondAddress = addressTag?.[1] ?? String(content.bondAddress ?? '');
    const bondTxid = txidTag?.[1] ?? (typeof content.bondTxid === 'string' ? content.bondTxid : undefined);
    const bondVout = voutTag !== undefined
      ? Number(voutTag[1])
      : (typeof content.bondVout === 'number' ? content.bondVout : undefined);
    const bondScriptPubKey = scriptTag?.[1]
      ?? (typeof content.bondScriptPubKey === 'string' ? content.bondScriptPubKey : undefined);
    const deadlineSeconds = deadlineTag !== undefined
      ? Number(deadlineTag[1])
      : (typeof content.deadlineSeconds === 'number' ? content.deadlineSeconds : undefined);

    // Reject events with malformed numeric fields instead of emitting NaN.
    if (!Number.isFinite(amountSats)) return null;
    if (bondVout !== undefined && (!Number.isInteger(bondVout) || bondVout < 0)) return null;
    if (deadlineSeconds !== undefined && !Number.isFinite(deadlineSeconds)) return null;

    const stakeCapacitySats = Number(content.stakeCapacitySats ?? 0);
    const wotScore = Number(content.wotScore ?? 0);
    const registeredAt = Number(content.registeredAt ?? event.created_at);
    if (!Number.isFinite(stakeCapacitySats) || !Number.isFinite(wotScore) || !Number.isFinite(registeredAt)) {
      return null;
    }

    const stakeCommitment: StakeCommitment = {
      amountSats,
      bondAddress,
      bondTxid,
      bondVout,
      scriptPubKey: bondScriptPubKey,
      deadlineSeconds,
      // NEVER fabricate confirmation here: the parser must not claim on-chain
      // status for the candidate. Admission authorities (e.g. the appeal
      // coordinator after its verifyStakeCommitment passes) stamp status.
      status: 'pending',
      committedAt: event.created_at,
    };

    return {
      nostrPubkey: event.pubkey!,
      stakeCapacitySats,
      stakeCommitment,
      wotScore,
      categories: categoryTags.length > 0
        ? categoryTags
        : Array.isArray(content.categories)
          ? content.categories.filter((c): c is string => typeof c === 'string')
          : [],
      registeredAt,
    };
  } catch {
    return null;
  }
}

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

export interface SelectedJurorEntry {
  idx: number;
  pubkey: string;
  stake: number;
}

export function parseSelectionEvent(
  event: NostrEventLike,
): { disputeId: string; marketId: string; selected: SelectedJurorEntry[]; backups: SelectedJurorEntry[]; seed: string; blockHash: string } | null {
  if (event.kind !== BAO_COURT_SELECTION_KIND) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const marketTag = event.tags.find((t) => t[0] === 'market');
    const seedTag = event.tags.find((t) => t[0] === 'seed');
    const blockTag = event.tags.find((t) => t[0] === 'block');

    const selected = event.tags
      .filter((t) => t[0] === 'selected')
      .map((t): SelectedJurorEntry => ({ idx: Number(t[1]), pubkey: t[2], stake: Number(t[3]) }));
    const backups = event.tags
      .filter((t) => t[0] === 'backup')
      .map((t): SelectedJurorEntry => ({ idx: Number(t[1]), pubkey: t[2], stake: Number(t[3]) }));

    if ([...selected, ...backups].some((j) => parsePositiveInt(j.idx) === null || !Number.isFinite(j.stake))) {
      return null;
    }

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      marketId: marketTag?.[1] ?? String(content.marketId ?? ''),
      selected,
      backups,
      seed: seedTag?.[1] ?? String(content.seed ?? ''),
      blockHash: blockTag?.[1] ?? String(content.blockHash ?? ''),
    };
  } catch {
    return null;
  }
}

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

export function parseDkgCommitmentEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; jurorPubkey: string; threshold: number; pok: DkgProofOfKnowledge; vssCommits: string[]; phaseNonce: string } | null {
  if (event.kind !== BAO_COURT_DKG_COMMITMENT_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');
    const thresholdTag = event.tags.find((t) => t[0] === 'threshold');
    const pokNTag = event.tags.find((t) => t[0] === 'pok_n');
    const pokZTag = event.tags.find((t) => t[0] === 'pok_z');
    const phaseNonceTag = event.tags.find((t) => t[0] === 'phase_nonce');
    const commits = event.tags.filter((t) => t[0] === 'commit').map((t) => t[1]);

    const contentPok = content.pok && typeof content.pok === 'object'
      ? (content.pok as Record<string, unknown>)
      : null;

    const pokNonce = pokNTag?.[1] ?? (typeof contentPok?.nonce === 'string' ? contentPok.nonce : '');
    const pokResponse = pokZTag?.[1] ?? (typeof contentPok?.response === 'string' ? contentPok.response : '');
    if (!pokNonce || !pokResponse) return null;
    const phaseNonce = phaseNonceTag?.[1]
      ?? (typeof content.phaseNonce === 'string' ? content.phaseNonce : '');
    if (!phaseNonce) return null;

    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      jurorPubkey: event.pubkey!,
      threshold: Number(thresholdTag?.[1] ?? content.threshold ?? 0),
      pok: { nonce: pokNonce, response: pokResponse },
      vssCommits: commits.length > 0 ? commits : Array.isArray(content.vssCommits) ? content.vssCommits.filter((c): c is string => typeof c === 'string') : [],
      phaseNonce,
    };
  } catch {
    return null;
  }
}

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

export function parseVoteCommitEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; commitHash: string } | null {
  if (event.kind !== BAO_COURT_VOTE_COMMIT_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');
    const commitTag = event.tags.find((t) => t[0] === 'commit');
    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;
    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      pubkey: event.pubkey!,
      commitHash: commitTag?.[1] ?? String(content.commitHash ?? ''),
    };
  } catch {
    return null;
  }
}

export function parseVoteRevealEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; outcome: string; salt: string } | null {
  if (event.kind !== BAO_COURT_VOTE_REVEAL_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');
    const outcomeTag = event.tags.find((t) => t[0] === 'outcome');
    const saltTag = event.tags.find((t) => t[0] === 'salt');
    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;
    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      pubkey: event.pubkey,
      outcome: outcomeTag?.[1] ?? String(content.outcome ?? ''),
      salt: saltTag?.[1] ?? String(content.salt ?? ''),
    };
  } catch {
    return null;
  }
}

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

export function parseFrostCommitEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; commitmentPackage: { idx: number; binder_pn: string; hidden_pn: string } } | null {
  if (event.kind !== BAO_COURT_FROST_COMMIT_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');
    const binderTag = event.tags.find((t) => t[0] === 'binder_pn');
    const hiddenTag = event.tags.find((t) => t[0] === 'hidden_pn');

    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;

    const contentPkg = content.commitmentPackage && typeof content.commitmentPackage === 'object'
      ? (content.commitmentPackage as Record<string, unknown>)
      : null;
    const binderPn = binderTag?.[1] ?? (typeof contentPkg?.binder_pn === 'string' ? contentPkg.binder_pn : '');
    const hiddenPn = hiddenTag?.[1] ?? (typeof contentPkg?.hidden_pn === 'string' ? contentPkg.hidden_pn : '');
    if (!binderPn || !hiddenPn) return null;

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      pubkey: event.pubkey!,
      commitmentPackage: { idx: jurorIdx, binder_pn: binderPn, hidden_pn: hiddenPn },
    };
  } catch {
    return null;
  }
}

export function parseFrostRevealEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; publicNonce: { idx: number; binder_pn: string; hidden_pn: string }; partialSig: string; frostPubkey: string } | null {
  if (event.kind !== BAO_COURT_FROST_REVEAL_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');
    const pkTag = event.tags.find((t) => t[0] === 'pk');
    const binderTag = event.tags.find((t) => t[0] === 'nonce_binder');
    const hiddenTag = event.tags.find((t) => t[0] === 'nonce_hidden');
    const psigTag = event.tags.find((t) => t[0] === 'psig');

    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;

    const contentNonce = content.publicNonce && typeof content.publicNonce === 'object'
      ? (content.publicNonce as Record<string, unknown>)
      : null;
    const binderPn = binderTag?.[1] ?? (typeof contentNonce?.binder_pn === 'string' ? contentNonce.binder_pn : '');
    const hiddenPn = hiddenTag?.[1] ?? (typeof contentNonce?.hidden_pn === 'string' ? contentNonce.hidden_pn : '');
    const partialSig = psigTag?.[1] ?? (typeof content.partialSig === 'string' ? content.partialSig : '');
    const frostPubkey = pkTag?.[1] ?? (typeof content.frostPubkey === 'string' ? content.frostPubkey : '');
    if (!binderPn || !hiddenPn || !partialSig || !frostPubkey) return null;

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      pubkey: event.pubkey!,
      publicNonce: { idx: jurorIdx, binder_pn: binderPn, hidden_pn: hiddenPn },
      partialSig,
      frostPubkey,
    };
  } catch {
    return null;
  }
}

export function parseAttestationEvent(
  event: NostrEventLike,
): FrostAttestation | null {
  if (event.kind !== BAO_COURT_ATTESTATION_KIND && event.kind !== 89) {
    return null;
  }

  const pTag = event.tags.find((t) => t[0] === 'p');
  const sigTag = event.tags.find((t) => t[0] === 'sig');
  const nonceTag = event.tags.find((t) => t[0] === 'nonce');
  const outcomeTag = event.tags.find((t) => t[0] === 'outcome');
  const roundTag = event.tags.find((t) => t[0] === 'round');
  const disputeTag = event.tags.find((t) => t[0] === 'dispute');
  const marketTag = event.tags.find((t) => t[0] === 'm');
  const verdictTag = event.tags.find((t) => t[0] === 'verdict');

  if (!pTag || !sigTag || !nonceTag) return null;

  const groupPubkey = pTag[1];
  const signature = sigTag[1];
  const pubNonce = nonceTag[1];
  const outcome = outcomeTag?.[1] ?? '';
  const round = roundTag?.[1] ?? '';

  if (!groupPubkey || !isHex64(groupPubkey)) return null;
  if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return null;
  if (!pubNonce || !isHex64(pubNonce)) return null;

  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(event.content || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }

  const marketId = marketTag?.[1] ?? String(content.marketId ?? '');
  const message = String(content.message ?? '');
  const disputeEventId = disputeTag?.[1] ?? (typeof content.disputeEventId === 'string' ? content.disputeEventId : undefined);
  const verdictHash = verdictTag?.[1] ?? (typeof content.verdictHash === 'string' ? content.verdictHash : undefined);
  const supportingEventIds = event.tags
    .filter((t) => t[0] === 'e' && t[3] === 'mention')
    .map((t) => t[1]);

  if (!marketId || !message || !round) return null;

  return {
    marketId,
    outcome,
    round,
    signature,
    pubNonce,
    groupPubkey,
    message,
    kind: event.kind as 89 | 39007,
    disputeEventId,
    verdictHash,
    supportingEventIds: supportingEventIds.length > 0 ? supportingEventIds : undefined,
  };
}

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
    throw new Error(
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
  throw new Error(
    'buildAttestationEvent: expected (attestation, marketEventId) or ' +
      '{ attestation, marketEventId }',
  );
}

export interface SelectionValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly selected?: { idx: number; pubkey: string; stake: number }[];
  readonly backups?: { idx: number; pubkey: string; stake: number }[];
}

/**
 * Validate the structure of a Kind 39002 selection event.
 */
export function validateSelectionEvent(
  event: Pick<NostrEvent, 'kind' | 'tags' | 'content'>,
  expectedDisputeId?: string,
): SelectionValidationResult {
  if (event.kind !== BAO_COURT_SELECTION_KIND) {
    return { valid: false, error: 'Not a Kind 39002 selection event' };
  }

  const disputeTag = event.tags.find((t) => t[0] === 'dispute');
  if (expectedDisputeId && disputeTag?.[1] !== expectedDisputeId) {
    return { valid: false, error: 'Dispute id mismatch' };
  }

  const selected = event.tags
    .filter((t) => t[0] === 'selected')
    .map((t) => ({ idx: Number(t[1]), pubkey: t[2], stake: Number(t[3]) }));
  const backups = event.tags
    .filter((t) => t[0] === 'backup')
    .map((t) => ({ idx: Number(t[1]), pubkey: t[2], stake: Number(t[3]) }));

  if (selected.length === 0) {
    return { valid: false, error: 'No selected jurors' };
  }

  const allJurors = [...selected, ...backups];
  if (allJurors.some((j) => !j.pubkey || !isNostrId(j.pubkey))) {
    return { valid: false, error: 'Invalid juror pubkey' };
  }
  if (allJurors.some((j) => Number.isNaN(j.idx) || j.idx < 1)) {
    return { valid: false, error: 'Invalid juror index' };
  }

  const indices = allJurors.map((j) => j.idx);
  const unique = new Set(indices);
  if (unique.size !== indices.length) {
    return { valid: false, error: 'Duplicate juror indices' };
  }

  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    if (!content.seed || !content.blockHash) {
      return { valid: false, error: 'Missing seed or block hash in content' };
    }
  } catch {
    return { valid: false, error: 'Invalid JSON content' };
  }

  return { valid: true, selected, backups };
}
