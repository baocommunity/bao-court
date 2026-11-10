// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Nostr event parsers/validators for the BAO Court / FROST appeal protocol.
 * Counterparts to the builders in `events.ts` (module barrel) — every parser
 * accepts the event shape its builder produced plus whatever a hostile
 * relay/client may have mangled, and fails closed with `null` or a typed
 * `{ valid: false }` result instead of throwing.
 *
 * Purity: pure functions; no I/O, no signature verification (callers
 * authenticate events before parsing).
 */

import type { Event as NostrEvent } from 'nostr-tools/pure';
import type { FrostAttestation, JurorProfile, StakeCommitment } from './types';
import type { DkgProofOfKnowledge } from './crypto';
import {
  findTag,
  findTagValue,
  isHex64,
  parseContentObject,
  parsePositiveInt,
} from './courtEventParseCore';
import {
  BAO_COURT_JUROR_CANDIDACY_KIND,
  BAO_COURT_SELECTION_KIND,
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_FROST_REVEAL_KIND,
  BAO_COURT_ATTESTATION_KIND,
  isNostrId,
  MAX_SUPPORTING_IDS,
  type NostrEventLike,
} from './eventsCommon';

/**
 * Parse a Kind 39001 candidacy event into a {@link JurorProfile}.
 *
 * Malformed numeric fields are rejected rather than coerced to `NaN`; the
 * stake commitment is always returned with `status: 'pending'` — the parser
 * never fabricates on-chain confirmation (admission authorities stamp status
 * after their own bond verification).
 *
 * @returns The parsed profile, or `null` when the event is not a valid
 *          candidacy (wrong kind, bad pubkey, unparsable content, or
 *          non-finite numerics). Never throws.
 */
export function parseJurorCandidacyEvent(
  event: NostrEventLike,
): JurorProfile | null {
  if (event.kind !== BAO_COURT_JUROR_CANDIDACY_KIND || !event.pubkey || !isNostrId(event.pubkey)) {
    return null;
  }

  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const bondTag = findTag(event.tags, 'bond');
    const addressTag = findTag(event.tags, 'address');
    const txidTag = findTag(event.tags, 'bondTxid');
    const voutTag = findTag(event.tags, 'bondVout');
    const scriptTag = findTag(event.tags, 'bondScript');
    const deadlineTag = findTag(event.tags, 'deadline');
    const ownershipNonceTag = findTag(event.tags, 'ownershipNonce');
    const ownershipSigTag = findTag(event.tags, 'ownershipSig');
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

    const ownershipProof =
      typeof ownershipNonceTag?.[1] === 'string' &&
      ownershipNonceTag[1].length > 0 &&
      ownershipNonceTag[1].length <= 128 &&
      typeof ownershipSigTag?.[1] === 'string' &&
      /^[0-9a-f]{128}$/i.test(ownershipSigTag[1])
        ? { challengeNonce: ownershipNonceTag[1], signature: ownershipSigTag[1].toLowerCase() }
        : undefined;

    const stakeCommitment: StakeCommitment = {
      amountSats,
      bondAddress,
      bondTxid,
      bondVout,
      scriptPubKey: bondScriptPubKey,
      deadlineSeconds,
      ownershipProof,
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

/** One juror entry in a selection event's selected/backup roster. */
export interface SelectedJurorEntry {
  /** 1-based roster index of the selected juror. */
  idx: number;
  /** Nostr (x-only) public key, hex. */
  pubkey: string;
  /** Bonded stake in satoshis at selection time. */
  stake: number;
}

/**
 * Parse a Kind 39002 selection event.
 *
 * Juror indices must be positive integers and stakes finite, else the event
 * is rejected.
 *
 * @returns The parsed selection payload, or `null` on any structural
 *          failure. Never throws.
 */
export function parseSelectionEvent(
  event: NostrEventLike,
): { disputeId: string; marketId: string; selected: SelectedJurorEntry[]; backups: SelectedJurorEntry[]; seed: string; blockHash: string } | null {
  if (event.kind !== BAO_COURT_SELECTION_KIND) return null;
  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const disputeTag = findTag(event.tags, 'dispute');
    const marketTag = findTag(event.tags, 'market');
    const seedTag = findTag(event.tags, 'seed');
    const blockTag = findTag(event.tags, 'block');

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

/**
 * Parse a Kind 38031 DKG-commitment event.
 *
 * @returns `{ disputeId, jurorIdx, jurorPubkey, threshold, pok, vssCommits,
 *            phaseNonce }`, or `null` when the kind, author pubkey,
 *            proof-of-knowledge fields, phase nonce, or juror index are
 *            missing/invalid. Never throws.
 */
export function parseDkgCommitmentEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; jurorPubkey: string; threshold: number; pok: DkgProofOfKnowledge; vssCommits: string[]; phaseNonce: string } | null {
  if (event.kind !== BAO_COURT_DKG_COMMITMENT_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const disputeTag = findTag(event.tags, 'dispute');
    const jurorTag = findTag(event.tags, 'juror');
    const thresholdTag = findTag(event.tags, 'threshold');
    const pokNTag = findTag(event.tags, 'pok_n');
    const pokZTag = findTag(event.tags, 'pok_z');
    const phaseNonceTag = findTag(event.tags, 'phase_nonce');
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

/**
 * Parse a Kind 39004 vote-commit event.
 *
 * @returns `{ disputeId, jurorIdx, pubkey, commitHash }`, or `null` when the
 *          kind, author pubkey, or juror index is invalid. Never throws.
 */
export function parseVoteCommitEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; commitHash: string } | null {
  if (event.kind !== BAO_COURT_VOTE_COMMIT_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const disputeTag = findTag(event.tags, 'dispute');
    const jurorTag = findTag(event.tags, 'juror');
    const commitTag = findTag(event.tags, 'commit');
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

/**
 * Parse a Kind 39014 vote-reveal event.
 *
 * @returns `{ disputeId, jurorIdx, pubkey, outcome, salt }`, or `null` when
 *          the kind, author pubkey, or juror index is invalid. Never throws.
 */
export function parseVoteRevealEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; outcome: string; salt: string } | null {
  if (event.kind !== BAO_COURT_VOTE_REVEAL_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const disputeTag = findTag(event.tags, 'dispute');
    const jurorTag = findTag(event.tags, 'juror');
    const outcomeTag = findTag(event.tags, 'outcome');
    const saltTag = findTag(event.tags, 'salt');
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

/**
 * Parse a Kind 39005 FROST signing-commitment event.
 *
 * @returns `{ disputeId, jurorIdx, pubkey, commitmentPackage }`, or `null`
 *          when the kind, author pubkey, juror index, or either nonce field
 *          is missing/invalid. Never throws.
 */
export function parseFrostCommitEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; commitmentPackage: { idx: number; binder_pn: string; hidden_pn: string } } | null {
  if (event.kind !== BAO_COURT_FROST_COMMIT_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const disputeTag = findTag(event.tags, 'dispute');
    const jurorTag = findTag(event.tags, 'juror');
    const binderTag = findTag(event.tags, 'binder_pn');
    const hiddenTag = findTag(event.tags, 'hidden_pn');

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

/**
 * Parse a Kind 39006 FROST signing-reveal event.
 *
 * @returns `{ disputeId, jurorIdx, pubkey, publicNonce, partialSig,
 *            frostPubkey }`, or `null` when any required field is missing or
 *          the kind/author/juror index is invalid. Never throws.
 */
export function parseFrostRevealEvent(
  event: NostrEventLike,
): { disputeId: string; jurorIdx: number; pubkey: string; publicNonce: { idx: number; binder_pn: string; hidden_pn: string }; partialSig: string; frostPubkey: string } | null {
  if (event.kind !== BAO_COURT_FROST_REVEAL_KIND || !event.pubkey || !isNostrId(event.pubkey)) return null;
  try {
    const content = parseContentObject(event.content);
    if (!content) return null;
    const disputeTag = findTag(event.tags, 'dispute');
    const jurorTag = findTag(event.tags, 'juror');
    const pkTag = findTag(event.tags, 'pk');
    const binderTag = findTag(event.tags, 'nonce_binder');
    const hiddenTag = findTag(event.tags, 'nonce_hidden');
    const psigTag = findTag(event.tags, 'psig');

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

/**
 * Parse a Kind 39007 (or legacy Kind 89) FROST attestation event.
 *
 * Structural validation only: hex shape of the group pubkey, public nonce,
 * and 128-hex-char signature, plus required tags/content. This does NOT
 * verify the Schnorr signature — feed the result through
 * {@link validateAttestationEvent} (validator module) for cryptographic
 * validation against the empaneled signer set.
 *
 * @returns The parsed {@link FrostAttestation}, or `null` on any structural
 *          failure. Never throws.
 *
 * @example
 * ```ts
 * const parsed = parseAttestationEvent(rawEvent);
 * if (parsed) {
 *   const v = validateAttestationEvent(rawEvent, { groupPubkey, ... });
 *   if (v.valid) acceptVerdict(parsed);
 * }
 * ```
 */
export function parseAttestationEvent(
  event: NostrEventLike,
): FrostAttestation | null {
  if (event.kind !== BAO_COURT_ATTESTATION_KIND && event.kind !== 89) {
    return null;
  }

  const pTag = findTag(event.tags, 'p');
  const sigTag = findTag(event.tags, 'sig');
  const nonceTag = findTag(event.tags, 'nonce');
  const outcomeTag = findTag(event.tags, 'outcome');
  const roundTag = findTag(event.tags, 'round');
  const disputeTag = findTag(event.tags, 'dispute');
  const marketTag = findTag(event.tags, 'm');
  const verdictTag = findTag(event.tags, 'verdict');

  if (!pTag || !sigTag || !nonceTag) return null;

  const groupPubkey = pTag[1];
  const signature = sigTag[1];
  const pubNonce = nonceTag[1];
  const outcome = outcomeTag?.[1] ?? '';
  const round = roundTag?.[1] ?? '';

  if (!groupPubkey || !isHex64(groupPubkey)) return null;
  if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) return null;
  if (!pubNonce || !isHex64(pubNonce)) return null;

  const content = parseContentObject(event.content);
  if (!content) return null;

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

/**
 * Outcome of a structural {@link validateSelectionEvent} check.
 */
export interface SelectionValidationResult {
  /** `true` when the event satisfies every structural rule. */
  readonly valid: boolean;
  /** Human-readable failure reason; present only when `valid` is `false`. */
  readonly error?: string;
  /** Parsed selected roster, present when parsing reached that stage. */
  readonly selected?: { idx: number; pubkey: string; stake: number }[];
  /** Parsed backup roster, present when parsing reached that stage. */
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

  const content = parseContentObject(event.content);
  if (!content) {
    return { valid: false, error: 'Invalid JSON content' };
  }
  if (!content.seed || !content.blockHash) {
    return { valid: false, error: 'Missing seed or block hash in content' };
  }

  return { valid: true, selected, backups };
}
