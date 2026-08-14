// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Builders and parsers for BAO Court DKG peer-to-peer messages.
 *
 * These events are either public (complaint) or encrypted via NIP-59
 * (encrypted share, self-backup). The builders return unsigned event templates;
 * callers must finalize and broadcast (and wrap when appropriate).
 */

import type { EventTemplate, Event as NostrEvent } from 'nostr-tools/pure';
import type {
  DkgComplaint,
  DkgComplaintDefense,
  EncryptedRefreshShare,
  EncryptedShareBackup,
  EncryptedVssShare,
  RefreshCommitment,
} from './types';

export const BAO_COURT_ENCRYPTED_SHARE_KIND = 39003;
export const BAO_COURT_DKG_COMPLAINT_KIND = 38032;
export const BAO_COURT_SHARE_BACKUP_KIND = 39100;
export const BAO_COURT_REFRESH_COMMITMENT_KIND = 38033;
export const BAO_COURT_REFRESH_SHARE_KIND = 39013;

interface NostrEventLike {
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly pubkey?: string;
  readonly created_at?: number;
  readonly id?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function dTag(disputeId: string, suffix?: string): [string, string] {
  return ['d', suffix !== undefined ? `${disputeId}:${suffix}` : disputeId];
}

/** Parse a positive integer (valid FROST/juror index); null when invalid. */
function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Build a kind 39003 encrypted VSS share event.
 * The returned event should be wrapped with NIP-59 before publishing.
 */
export function buildEncryptedShareEvent(
  payload: EncryptedVssShare,
): EventTemplate {
  const suffix = `${payload.fromIdx}:${payload.toIdx}`;
  return {
    kind: BAO_COURT_ENCRYPTED_SHARE_KIND,
    created_at: nowSeconds(),
    tags: [
      dTag(payload.disputeId, suffix),
      ['e', payload.disputeId, '', 'root'],
      ['dispute', payload.disputeId],
      ['from', String(payload.fromIdx), payload.fromPubkey],
      ['to', String(payload.toIdx), payload.toPubkey],
    ],
    content: JSON.stringify({
      disputeId: payload.disputeId,
      fromIdx: payload.fromIdx,
      fromPubkey: payload.fromPubkey,
      toIdx: payload.toIdx,
      toPubkey: payload.toPubkey,
      encryptedShare: payload.encryptedShare,
      ephemeralPubkey: payload.ephemeralPubkey,
      phaseNonce: payload.phaseNonce,
    }),
  };
}

export function parseEncryptedShareEvent(
  event: NostrEventLike,
): EncryptedVssShare | null {
  if (event.kind !== BAO_COURT_ENCRYPTED_SHARE_KIND) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const fromTag = event.tags.find((t) => t[0] === 'from');
    const toTag = event.tags.find((t) => t[0] === 'to');

    const fromIdx = parsePositiveInt(fromTag?.[1] ?? content.fromIdx);
    const toIdx = parsePositiveInt(toTag?.[1] ?? content.toIdx);
    if (fromIdx === null || toIdx === null) return null;
    const encryptedShare = typeof content.encryptedShare === 'string'
      ? content.encryptedShare
      : '';
    const phaseNonce = typeof content.phaseNonce === 'string'
      ? content.phaseNonce
      : '';
    if (!encryptedShare || !phaseNonce) return null;

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      fromIdx,
      fromPubkey: fromTag?.[2] ?? String(content.fromPubkey ?? ''),
      toIdx,
      toPubkey: toTag?.[2] ?? String(content.toPubkey ?? ''),
      encryptedShare,
      ephemeralPubkey: typeof content.ephemeralPubkey === 'string'
        ? content.ephemeralPubkey
        : undefined,
      phaseNonce,
    };
  } catch {
    return null;
  }
}

/**
 * Build a kind 38032 DKG complaint event.
 * The complaint is public and includes the revealed invalid share plus the
 * accused juror's commitment event id.
 */
export function buildDkgComplaintEvent(
  complaint: DkgComplaint,
): EventTemplate {
  const suffix = `${complaint.victimIdx}:${complaint.accusedIdx}`;
  const tags: string[][] = [
    dTag(complaint.disputeId, suffix),
    ['e', complaint.disputeId, '', 'root'],
    ['dispute', complaint.disputeId],
    ['accused', String(complaint.accusedIdx), complaint.accusedPubkey],
    ['victim', String(complaint.victimIdx), complaint.victimPubkey],
    ['commitment', complaint.commitmentEventId],
  ];

  const content: Record<string, unknown> = {
    disputeId: complaint.disputeId,
    accusedIdx: complaint.accusedIdx,
    accusedPubkey: complaint.accusedPubkey,
    victimIdx: complaint.victimIdx,
    victimPubkey: complaint.victimPubkey,
    revealedShare: complaint.revealedShare,
    commitmentEventId: complaint.commitmentEventId,
  };

  if (complaint.defense) {
    content.defense = complaint.defense;
  }

  return {
    kind: BAO_COURT_DKG_COMPLAINT_KIND,
    created_at: nowSeconds(),
    tags,
    content: JSON.stringify(content),
  };
}

export function parseDkgComplaintEvent(
  event: NostrEventLike,
): DkgComplaint | null {
  if (event.kind !== BAO_COURT_DKG_COMPLAINT_KIND) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const accusedTag = event.tags.find((t) => t[0] === 'accused');
    const victimTag = event.tags.find((t) => t[0] === 'victim');
    const commitmentTag = event.tags.find((t) => t[0] === 'commitment');

    const accusedIdx = parsePositiveInt(accusedTag?.[1] ?? content.accusedIdx);
    const victimIdx = parsePositiveInt(victimTag?.[1] ?? content.victimIdx);
    if (accusedIdx === null || victimIdx === null) return null;
    const revealedShare = typeof content.revealedShare === 'string'
      ? content.revealedShare
      : '';
    const commitmentEventId = commitmentTag?.[1]
      ?? (typeof content.commitmentEventId === 'string' ? content.commitmentEventId : '');
    if (!revealedShare || !commitmentEventId) return null;

    let defense: DkgComplaintDefense | undefined;
    const defenseRaw = content.defense;
    if (defenseRaw && typeof defenseRaw === 'object') {
      const d = defenseRaw as Record<string, unknown>;
      defense = {
        decryptionProof: String(d.decryptionProof ?? ''),
        validShare: String(d.validShare ?? ''),
        defendedAt: Number(d.defendedAt ?? 0),
      };
    }

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      accusedIdx,
      accusedPubkey: accusedTag?.[2] ?? String(content.accusedPubkey ?? ''),
      victimIdx,
      victimPubkey: victimTag?.[2] ?? String(content.victimPubkey ?? ''),
      revealedShare,
      commitmentEventId,
      defense,
    };
  } catch {
    return null;
  }
}

/**
 * Build a kind 39100 encrypted self-backup event.
 * The returned event should be wrapped with NIP-59 to the juror themself.
 */
export function buildShareBackupEvent(
  payload: EncryptedShareBackup,
): EventTemplate {
  return {
    kind: BAO_COURT_SHARE_BACKUP_KIND,
    created_at: nowSeconds(),
    tags: [
      dTag(payload.disputeId, String(payload.jurorIdx)),
      ['e', payload.disputeId, '', 'root'],
      ['dispute', payload.disputeId],
      ['juror', String(payload.jurorIdx), payload.jurorPubkey],
    ],
    content: JSON.stringify({
      disputeId: payload.disputeId,
      jurorIdx: payload.jurorIdx,
      jurorPubkey: payload.jurorPubkey,
      encryptedShare: payload.encryptedShare,
      groupPubkey: payload.groupPubkey,
      verificationShares: payload.verificationShares,
      vssCommitments: payload.vssCommitments,
    }),
  };
}

export function parseShareBackupEvent(
  event: NostrEventLike,
): EncryptedShareBackup | null {
  if (event.kind !== BAO_COURT_SHARE_BACKUP_KIND) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');

    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;
    const encryptedShare = typeof content.encryptedShare === 'string'
      ? content.encryptedShare
      : '';
    const groupPubkey = typeof content.groupPubkey === 'string'
      ? content.groupPubkey
      : '';
    if (!encryptedShare || !groupPubkey) return null;

    const verificationShares = Array.isArray(content.verificationShares)
      ? content.verificationShares.filter(
          (v): v is { idx: number; pubkey: string } =>
            !!v && typeof v === 'object'
            && typeof (v as Record<string, unknown>).idx === 'number'
            && typeof (v as Record<string, unknown>).pubkey === 'string',
        )
      : [];
    const vssCommitments = Array.isArray(content.vssCommitments)
      ? content.vssCommitments.filter(
          (v): v is { idx: number; pubkey: string; commits: string[] } =>
            !!v && typeof v === 'object'
            && typeof (v as Record<string, unknown>).idx === 'number'
            && typeof (v as Record<string, unknown>).pubkey === 'string'
            && Array.isArray((v as Record<string, unknown>).commits)
            && ((v as Record<string, unknown>).commits as unknown[]).every(
              (c) => typeof c === 'string',
            ),
        )
      : [];

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      jurorPubkey: jurorTag?.[2] ?? String(content.jurorPubkey ?? ''),
      encryptedShare,
      groupPubkey,
      verificationShares,
      vssCommitments,
    };
  } catch {
    return null;
  }
}

/**
 * Build a kind 38033 refresh commitment event.
 * The returned event is public and should be broadcast to all peers.
 */
export function buildRefreshCommitmentEvent(
  payload: RefreshCommitment,
): EventTemplate {
  return {
    kind: BAO_COURT_REFRESH_COMMITMENT_KIND,
    created_at: nowSeconds(),
    tags: [
      dTag(payload.disputeId, String(payload.jurorIdx)),
      ['e', payload.disputeId, '', 'root'],
      ['dispute', payload.disputeId],
      ['juror', String(payload.jurorIdx)],
      ['threshold', String(payload.threshold)],
      ['phase_nonce', payload.phaseNonce],
      ...payload.vssCommits.map((c): [string, string] => ['commit', c]),
      ['alt', `BAO Court refresh commitment from juror ${payload.jurorIdx}`],
    ],
    content: JSON.stringify({
      disputeId: payload.disputeId,
      jurorIdx: payload.jurorIdx,
      threshold: payload.threshold,
      phaseNonce: payload.phaseNonce,
      vssCommits: payload.vssCommits,
    }),
  };
}

export function parseRefreshCommitmentEvent(
  event: NostrEventLike,
): RefreshCommitment | null {
  if (event.kind !== BAO_COURT_REFRESH_COMMITMENT_KIND) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const jurorTag = event.tags.find((t) => t[0] === 'juror');
    const thresholdTag = event.tags.find((t) => t[0] === 'threshold');
    const phaseNonceTag = event.tags.find((t) => t[0] === 'phase_nonce');
    const commits = event.tags.filter((t) => t[0] === 'commit').map((t) => t[1]);

    const phaseNonce = phaseNonceTag?.[1]
      ?? (typeof content.phaseNonce === 'string' ? content.phaseNonce : '');
    if (!phaseNonce) return null;

    const jurorIdx = parsePositiveInt(jurorTag?.[1] ?? content.jurorIdx);
    if (jurorIdx === null) return null;

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      jurorIdx,
      jurorPubkey: event.pubkey ?? '',
      threshold: Number(thresholdTag?.[1] ?? content.threshold ?? 0),
      vssCommits: commits.length > 0
        ? commits
        : Array.isArray(content.vssCommits)
          ? content.vssCommits.filter((c): c is string => typeof c === 'string')
          : [],
      phaseNonce,
    };
  } catch {
    return null;
  }
}

/**
 * Build a kind 39013 encrypted refresh share event.
 * The returned event should be wrapped with NIP-59 before publishing.
 */
export function buildEncryptedRefreshShareEvent(
  payload: EncryptedRefreshShare,
): EventTemplate {
  const suffix = `${payload.fromIdx}:${payload.toIdx}`;
  return {
    kind: BAO_COURT_REFRESH_SHARE_KIND,
    created_at: nowSeconds(),
    tags: [
      dTag(payload.disputeId, suffix),
      ['e', payload.disputeId, '', 'root'],
      ['dispute', payload.disputeId],
      ['from', String(payload.fromIdx), payload.fromPubkey],
      ['to', String(payload.toIdx), payload.toPubkey],
    ],
    content: JSON.stringify({
      disputeId: payload.disputeId,
      fromIdx: payload.fromIdx,
      fromPubkey: payload.fromPubkey,
      toIdx: payload.toIdx,
      toPubkey: payload.toPubkey,
      encryptedShare: payload.encryptedShare,
      phaseNonce: payload.phaseNonce,
    }),
  };
}

export function parseEncryptedRefreshShareEvent(
  event: NostrEventLike,
): EncryptedRefreshShare | null {
  if (event.kind !== BAO_COURT_REFRESH_SHARE_KIND) return null;
  try {
    const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
    const disputeTag = event.tags.find((t) => t[0] === 'dispute');
    const fromTag = event.tags.find((t) => t[0] === 'from');
    const toTag = event.tags.find((t) => t[0] === 'to');

    const fromIdx = parsePositiveInt(fromTag?.[1] ?? content.fromIdx);
    const toIdx = parsePositiveInt(toTag?.[1] ?? content.toIdx);
    if (fromIdx === null || toIdx === null) return null;
    const encryptedShare = typeof content.encryptedShare === 'string'
      ? content.encryptedShare
      : '';
    const phaseNonce = typeof content.phaseNonce === 'string'
      ? content.phaseNonce
      : '';
    if (!encryptedShare || !phaseNonce) return null;

    return {
      disputeId: disputeTag?.[1] ?? String(content.disputeId ?? ''),
      fromIdx,
      fromPubkey: fromTag?.[2] ?? String(content.fromPubkey ?? ''),
      toIdx,
      toPubkey: toTag?.[2] ?? String(content.toPubkey ?? ''),
      encryptedShare,
      phaseNonce,
    };
  } catch {
    return null;
  }
}

