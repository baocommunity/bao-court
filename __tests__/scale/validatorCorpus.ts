// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * CAMPAIGN 4 — signed v2 attestation accept/reject matrix at scale.
 *
 * Every corpus unit is a REAL signed Nostr event: a valid kind-89 (or
 * kind-39007) attestation carrying a real Schnorr group signature over the
 * canonical v2 message, wrapped in an event signed by a real publisher key.
 * The event is validated through `validateCourtAttestation` (the recommended
 * dispatcher) with the full finality pin set a consumer would use.
 *
 * Matrix rows (rotated; the exact row set and counts land in the artifact):
 *
 *   ACCEPT — valid event with every pin satisfied (group key, epoch, tier,
 *            threshold, signer-set root, signer set), in both kind shapes and
 *            with optional attempt / batch tags.
 *   REJECT — 32 single-property tampers, each expected to fail for its OWN
 *            reason: content/tag divergence on every v2 field, nonce/sig
 *            mismatch, wrong signing key, truncated signature, message
 *            substitution, malformed or absent finality tags, out-of-range
 *            tier/threshold, oversized marketId/outcome/round, policy-pin
 *            mismatches (epoch, tier, threshold, signer-set root, signer-set
 *            size, batch root), a wrong-kind event, an untrusted publisher,
 *            and a forged / missing dispute verdict binding.
 *
 * A rejection only counts as CORRECT when the returned error names the expected
 * failure mode (substring match), not merely `valid === false`.
 *
 * COST NOTE: the group signature binds only the protocol fields, so it is
 * computed once per distinct field combo and reused by the events that share
 * that combo; every event still carries its OWN publisher signature over its
 * own event id, and every event is validated individually. The combo pool is
 * capped (see `comboCount`) and the artifact records the pool size. All keys
 * are DERIVED from the campaign seed (no CSPRNG), so the whole run is
 * reproducible from `(seed, size)`.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';

import { buildAttestationMessageV2 } from '../../crypto';
import { hashCourtVerdict, hashDisputeVerdict } from '../../courtVoteMachine';
import { hashSignerSetRoot, validateCourtAttestation } from '../../validator';
import { BAO_COURT_ATTESTATION_KIND } from '../../events';
import { childRng, int, pick } from '../helpers/rng';
import { CampaignReporter, nowMs, type CampaignResult } from './corpus';

const MARKET_IDS = ['demo-market', 'märkte-1', '市场-2', '😀-market', 'm'.repeat(64), 'order-42'] as const;
const OUTCOMES = ['YES', 'NO', 'PENDING', 'é😀'] as const;
const ATTEMPTS = [0, 1, 2, 3, 17] as const;
const KEY_LABELS = ['group', 'publisher-0', 'publisher-1', 'publisher-2', 'publisher-3', 'stranger'] as const;

/**
 * Deterministic 32-byte secret for a label: `sha256('BAO-Court/scale/' ‖ label)`.
 * Reproducible from the campaign seed and never CSPRNG-derived (house rule).
 */
function deriveSecret(seed: number, label: string): { sec: Uint8Array; pub: string } {
  const sec = sha256(new TextEncoder().encode(`BAO-Court/scale/${seed}/${label}`));
  return { sec, pub: getPublicKey(sec) };
}

/** Coherent base field combo plus its precomputed digests and group signature. */
interface FieldCombo {
  readonly marketId: string;
  readonly outcome: string;
  readonly round: string;
  readonly epochId: number;
  readonly tier: number;
  readonly threshold: number;
  readonly signerSet: readonly number[];
  readonly signerSetRoot: string;
  readonly attempt?: number;
  readonly batchMerkleRoot?: string;
  readonly disputeEventId: string;
  readonly supportingIds: readonly string[];
  readonly verdictHash: string;
  /** Canonical v2 message digest (hex) and its cached group signature. */
  readonly message: string;
  readonly signature: string;
}

/** One matrix row: the event spec it produced and the outcome it must yield. */
interface MatrixRow {
  readonly name: string;
  readonly valid: boolean;
  /** Expected error substring for a REJECT row. */
  readonly expect?: string;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
  readonly publisherSecret: Uint8Array;
}

/**
 * Serialise the v2 content mirror. `override` tampers ONE mirror field while the
 * tags stay untouched — the tag↔content consistency table is what must reject
 * it (a tag-side tamper would instead be caught by a policy pin, e.g. the epoch
 * pin, which would prove less about the consistency check itself).
 */
function contentFor(combo: FieldCombo, override: {
  readonly verdictHash?: string;
  readonly outcome?: string;
  readonly marketId?: string;
  readonly round?: string;
  readonly epoch?: string;
  readonly tier?: string;
  readonly threshold?: string;
  readonly signerSetRoot?: string;
  readonly attempt?: string;
} = {}): string {
  return JSON.stringify({
    marketId: override.marketId ?? combo.marketId,
    outcome: override.outcome ?? combo.outcome,
    round: override.round ?? combo.round,
    message: combo.message,
    disputeEventId: combo.disputeEventId,
    verdictHash: override.verdictHash ?? combo.verdictHash,
    epoch: override.epoch ?? String(combo.epochId),
    tier: override.tier ?? String(combo.tier),
    threshold: override.threshold ?? String(combo.threshold),
    signerSetRoot: override.signerSetRoot ?? combo.signerSetRoot,
    ...(override.attempt !== undefined ? { attempt: override.attempt } : {}),
    ...(override.attempt === undefined && combo.attempt !== undefined ? { attempt: String(combo.attempt) } : {}),
    ...(combo.batchMerkleRoot !== undefined ? { batchMerkleRoot: combo.batchMerkleRoot } : {}),
  });
}

/** Tag list in the production shape. */
function tagsFor(
  combo: FieldCombo,
  groupPubkey: string,
  options: {
    readonly outcome?: string;
    readonly marketId?: string;
    readonly round?: string;
    readonly epoch?: string;
    readonly tier?: string;
    readonly threshold?: string;
    readonly signers?: string;
    readonly sig?: string;
    readonly nonce?: string;
    readonly dispute?: string;
    readonly verdict?: string;
    readonly attempt?: string;
    readonly batch?: string;
    readonly omit?: readonly string[];
    readonly extra?: readonly string[][];
  } = {},
): string[][] {
  const omit = new Set(options.omit ?? []);
  const tags: string[][] = [];
  const push = (name: string, value: string | undefined): void => {
    if (value === undefined || omit.has(name)) return;
    tags.push([name, value]);
  };
  const sig = options.sig ?? combo.signature;
  push('m', options.marketId ?? combo.marketId);
  push('p', groupPubkey);
  push('outcome', options.outcome ?? combo.outcome);
  push('round', options.round ?? combo.round);
  push('nonce', options.nonce ?? sig.slice(0, 64));
  push('sig', sig);
  push('epoch', options.epoch ?? String(combo.epochId));
  push('tier', options.tier ?? String(combo.tier));
  push('threshold', options.threshold ?? String(combo.threshold));
  push('signers', options.signers ?? combo.signerSetRoot);
  push('dispute', options.dispute ?? combo.disputeEventId);
  push('verdict', options.verdict ?? combo.verdictHash);
  push('attempt', options.attempt ?? (combo.attempt !== undefined ? String(combo.attempt) : undefined));
  push('batch', options.batch ?? combo.batchMerkleRoot);
  for (const id of combo.supportingIds) tags.push(['e', id, '', 'mention']);
  for (const extra of options.extra ?? []) tags.push([...extra]);
  return tags;
}

/** The 32 tamper rows, in rotation order. */
const TAMPER_ROWS = [
  'outcome-content-divergence',
  'market-content-divergence',
  'round-content-divergence',
  'epoch-content-divergence',
  'tier-content-divergence',
  'threshold-content-divergence',
  'signers-content-divergence',
  'attempt-content-divergence',
  'message-substitution',
  'nonce-mismatch',
  'sig-truncated',
  'sig-wrong-signer',
  'wrong-group-key',
  'missing-epoch-tag',
  'missing-signers-tag',
  'epoch-malformed',
  'tier-out-of-range',
  'threshold-zero',
  'signers-malformed',
  'outcome-too-long',
  'market-too-long',
  'round-too-long',
  'wrong-kind',
  'epoch-pin-mismatch',
  'tier-pin-mismatch',
  'threshold-pin-mismatch',
  'signers-pin-mismatch',
  'signer-set-size-mismatch',
  'batch-pin-mismatch',
  'untrusted-publisher',
  'dispute-missing-tag',
  'dispute-verdict-forgery',
] as const;

type TamperRow = (typeof TAMPER_ROWS)[number];

/**
 * Run the validator campaign.
 *
 * @param opts.size number of signed events
 * @param opts.seed campaign seed (also derives every key)
 */
export function runValidatorCampaign(opts: { readonly size: number; readonly seed?: number }): CampaignResult {
  const seed = opts.seed ?? 20_261_111;
  const started = nowMs();
  const reporter = new CampaignReporter('validator', 'events', opts.size, seed);
  const r = childRng(seed, 'validator-campaign');

  const group = deriveSecret(seed, 'group');
  const publishers = KEY_LABELS.slice(1, 5).map((label) => deriveSecret(seed, label));
  const stranger = deriveSecret(seed, 'stranger');
  const trustedPublishers = publishers.map((publisher) => publisher.pub);

  // Distinct field combos: capped so the group-signature amortisation is real
  // while the field space stays wide (a fresh combo every ~12 events at full size).
  const comboCount = Math.max(16, Math.min(4096, Math.ceil(opts.size / 12)));
  const combos: Array<FieldCombo | undefined> = new Array(comboCount).fill(undefined);
  const messageSignatures = new Map<string, string>();
  let groupSignatures = 0;
  const signMessage = (message: string): string => {
    const cached = messageSignatures.get(message);
    if (cached !== undefined) return cached;
    const signature = bytesToHex(schnorr.sign(hexToBytes(message), group.sec));
    messageSignatures.set(message, signature);
    groupSignatures += 1;
    return signature;
  };

  const buildCombo = (index: number): FieldCombo => {
    const marketId = pick(r, MARKET_IDS);
    const outcome = pick(r, OUTCOMES);
    const round = String(int(r, 0, 5));
    const epochId = int(r, 1, 0xffff_ffff);
    const tier = int(r, 0, 255);
    const threshold = int(r, 1, 5);
    const signerSet = Array.from({ length: threshold }, (_, i) => i + 1);
    const signerSetRoot = hashSignerSetRoot(signerSet);
    const attempt = r() < 0.35 ? pick(r, ATTEMPTS) : undefined;
    const batchMerkleRoot = r() < 0.3 ? `${index.toString(16).padStart(4, '0')}`.padEnd(64, 'b') : undefined;
    // Every combo is dispute-shaped, so the dispute rows always apply: the
    // verdict commitment is recomputed from the event's own inputs.
    const supportingIds = [`${index.toString(16).padStart(8, '0')}`.padEnd(64, 'd')];
    const disputeEventId = hashCourtVerdict({
      sessionHash: '11'.repeat(32),
      outcome,
      supportingEventIds: supportingIds,
    });
    const verdictHash = hashDisputeVerdict({ disputeId: disputeEventId, outcome, supportingEventIds: supportingIds });
    const message = buildAttestationMessageV2({
      marketId,
      outcome,
      round: Number(round),
      disputeEventId,
      verdictHash,
      epochId,
      tier,
      threshold,
      signerSetRoot,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(batchMerkleRoot !== undefined ? { batchMerkleRoot } : {}),
    });
    return {
      marketId, outcome, round, epochId, tier, threshold, signerSet, signerSetRoot,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(batchMerkleRoot !== undefined ? { batchMerkleRoot } : {}),
      disputeEventId, supportingIds, verdictHash,
      message,
      signature: signMessage(message),
    };
  };

  const comboAt = (index: number): FieldCombo => {
    const slot = index % comboCount;
    const cached = combos[slot];
    if (cached !== undefined) return cached;
    const built = buildCombo(index);
    combos[slot] = built;
    return built;
  };

  const metrics = {
    accepted: 0,
    rejected: 0,
    disputeShaped: 0,
    batchEvents: 0,
    attemptEvents: 0,
    comboPool: comboCount,
    distinctRows: 0,
  };
  const rowCounts = new Map<string, number>();

  for (let index = 0; index < opts.size; index += 1) {
    const combo = comboAt(index);
    const publisher = publishers[index % publishers.length]!;
    const label = `event#${index}`;
    if (combo.batchMerkleRoot !== undefined) metrics.batchEvents += 1;
    if (index % 3 === 0) metrics.disputeShaped += 1;
    if (combo.attempt !== undefined) metrics.attemptEvents += 1;

    const row = buildRow(index, combo, group.pub, publisher.sec, stranger.sec);
    rowCounts.set(row.name, (rowCounts.get(row.name) ?? 0) + 1);

    let event: NostrEvent;
    try {
      event = finalizeEvent(
        { kind: row.kind, created_at: 1 + (index % 1000), tags: row.tags, content: row.content },
        row.publisherSecret,
      );
    } catch (err) {
      reporter.fail(label, `event finalisation threw: ${describe(err)}`);
      continue;
    }

    // The consumer's pin set — plus the single policy pin each mismatch row
    // deliberately raises past what the event can satisfy.
    const context = {
      expectedGroupPubkey: group.pub,
      expectedEpoch: row.name === 'epoch-pin-mismatch' ? combo.epochId + 1 : combo.epochId,
      minTier: row.name === 'tier-pin-mismatch' ? combo.tier + 1 : 0,
      minThreshold: row.name === 'threshold-pin-mismatch' ? combo.threshold + 1 : 1,
      expectedSignerSetRoot: row.name === 'signers-pin-mismatch' ? hashSignerSetRoot([7, 8, 9]) : combo.signerSetRoot,
      signerSet: row.name === 'signer-set-size-mismatch' ? [...combo.signerSet, 99] : combo.signerSet,
      ...(row.name === 'batch-pin-mismatch' ? { expectedBatchMerkleRoot: 'ff'.repeat(32) } : {}),
      trustedPublisherPubkeys: trustedPublishers,
    };

    let result: { valid: boolean; error?: string };
    try {
      result = validateCourtAttestation(event, context);
    } catch (err) {
      reporter.fail(label, `${row.name}: validator THREW instead of returning a typed result: ${describe(err)}`);
      continue;
    }

    if (row.valid) {
      reporter.ok(label, result.valid, `ACCEPT row '${row.name}' was rejected: ${result.error ?? 'no reason'}`);
      if (result.valid) metrics.accepted += 1;
      continue;
    }
    if (result.valid) {
      reporter.fail(label, `REJECT row '${row.name}' reported valid=true (expected '${row.expect}')`);
      continue;
    }
    const reason = result.error ?? '';
    reporter.ok(
      label,
      row.expect !== undefined && reason.includes(row.expect),
      `REJECT row '${row.name}' failed for the wrong reason: expected '${row.expect}', got '${reason}'`,
    );
    metrics.rejected += 1;
  }

  const wallMs = nowMs() - started;
  metrics.distinctRows = rowCounts.size;
  return reporter.finish(
    wallMs,
    {
      ...metrics,
      groupSignatures,
      publisherSignatures: opts.size,
      eventsPerSecond: Math.round((opts.size / Math.max(1, wallMs)) * 1000),
    },
    [
      `group signature cached per distinct message (${groupSignatures} group signs, ${comboCount}-combo pool); every event has its own publisher signature and validation`,
      `matrix rows exercised: ${[...rowCounts.keys()].sort().join(', ')}`,
      'all keys are derived from the campaign seed (sha256 labels) — the run is reproducible, no CSPRNG',
    ],
  );
}

/**
 * Build one matrix row: exactly one field or structural property is broken per
 * REJECT row; the ACCEPT rows vary only the option shape (kind, attempt, batch).
 */
function buildRow(
  index: number,
  combo: FieldCombo,
  groupPub: string,
  publisherSecret: Uint8Array,
  strangerSecret: Uint8Array,
): MatrixRow {
  const baseTags = tagsFor(combo, groupPub);
  const baseContent = contentFor(combo);
  // Alternate the event shape: 2/3 kind-89, 1/3 kind-39007 dispute attestations.
  const kind = index % 3 === 0 ? BAO_COURT_ATTESTATION_KIND : 89;
  const accept = (name: string): MatrixRow => ({
    name, valid: true, kind, tags: baseTags, content: baseContent, publisherSecret,
  });
  const reject = (
    name: TamperRow,
    expect: string,
    spec: { readonly kind?: number; readonly tags?: string[][]; readonly content?: string; readonly publisherSecret?: Uint8Array } = {},
  ): MatrixRow => ({
    name,
    valid: false,
    expect,
    kind: spec.kind ?? kind,
    tags: spec.tags ?? baseTags,
    content: spec.content ?? baseContent,
    publisherSecret: spec.publisherSecret ?? publisherSecret,
  });

  // Half the corpus is the ACCEPT path; the other half rotates the matrix.
  if (index % 2 === 0) return accept(index % 4 === 0 ? 'accept' : 'accept-option-shape');

  const row = TAMPER_ROWS[Math.floor(index / 2) % TAMPER_ROWS.length]!;
  const tagsWith = (options: Parameters<typeof tagsFor>[2]): string[][] => tagsFor(combo, groupPub, options);

  switch (row) {
    case 'outcome-content-divergence':
      return reject(row, 'outcome tag does not match content', { content: contentFor(combo, { outcome: 'TAMPERED' }) });
    case 'market-content-divergence':
      return reject(row, 'marketId tag does not match content', { content: contentFor(combo, { marketId: `${combo.marketId}-x` }) });
    case 'round-content-divergence':
      return reject(row, 'round tag does not match content', { content: contentFor(combo, { round: `${combo.round}9` }) });
    case 'epoch-content-divergence':
      return reject(row, 'epoch tag does not match content', { content: contentFor(combo, { epoch: String(combo.epochId + 1) }) });
    case 'tier-content-divergence':
      return reject(row, 'tier tag does not match content', { content: contentFor(combo, { tier: String((combo.tier + 1) % 256) }) });
    case 'threshold-content-divergence':
      return reject(row, 'threshold tag does not match content', { content: contentFor(combo, { threshold: String(combo.threshold + 1) }) });
    case 'signers-content-divergence':
      return reject(row, 'signerSetRoot tag does not match content', { content: contentFor(combo, { signerSetRoot: 'aa'.repeat(32) }) });
    case 'attempt-content-divergence':
      return reject(row, 'attempt tag does not match content', { content: contentFor(combo, { attempt: String((combo.attempt ?? 0) + 1) }) });
    case 'message-substitution': {
      // Tags and content mirror each other, but `message` binds a DIFFERENT
      // field tuple than the tags claim.
      const forged = buildAttestationMessageV2({
        marketId: combo.marketId,
        outcome: combo.outcome,
        round: Number(combo.round),
        disputeEventId: combo.disputeEventId,
        verdictHash: combo.verdictHash,
        epochId: combo.epochId,
        tier: combo.tier,
        threshold: combo.threshold + 1,
        signerSetRoot: combo.signerSetRoot,
        ...(combo.attempt !== undefined ? { attempt: combo.attempt } : {}),
        ...(combo.batchMerkleRoot !== undefined ? { batchMerkleRoot: combo.batchMerkleRoot } : {}),
      });
      const content = JSON.parse(baseContent) as Record<string, unknown>;
      content.message = forged;
      return reject(row, 'Attestation message does not bind v2 finality fields', { content: JSON.stringify(content) });
    }
    case 'nonce-mismatch': {
      // The nonce tag is the signature's first 64 hex chars by contract. Flip a
      // character INSIDE that window on the nonce only, so the nonce↔signature
      // binding is what rejects the event (before any Schnorr work).
      const position = index % 63;
      const replacement = combo.signature[position] === '0' ? '1' : '0';
      const tamperedNonce = `${combo.signature.slice(0, position)}${replacement}${combo.signature.slice(position + 1, 64)}`;
      return reject(row, 'Nonce tag does not match signature', { tags: tagsWith({ nonce: tamperedNonce }) });
    }
    case 'sig-truncated':
      return reject(row, 'Invalid group pubkey, signature, or nonce', { tags: tagsWith({ sig: combo.signature.slice(0, 127) }) });
    case 'sig-wrong-signer': {
      // Self-consistent (nonce = sig prefix) but over an unrelated message.
      const unrelated = bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(`unrelated/${index}`)), strangerSecret));
      return reject(row, 'Schnorr signature verification failed', {
        tags: tagsWith({ sig: unrelated, nonce: unrelated.slice(0, 64) }),
      });
    }
    case 'wrong-group-key':
      return reject(row, 'Pubkey mismatch', { tags: tagsFor(combo, getPublicKey(strangerSecret)) });
    case 'missing-epoch-tag':
      // Without an epoch tag the dispatcher takes the FROZEN v1 path, and v2
      // finality policy on a v1-shaped event is refused (FINDING-1 downgrade
      // refusal) — the row pins that fail-closed answer.
      return reject(row, 'downgrade refused', { tags: tagsWith({ omit: ['epoch'] }) });
    case 'missing-signers-tag':
      return reject(row, 'Missing v2 finality tags', { tags: tagsWith({ omit: ['signers'] }) });
    case 'epoch-malformed':
      return reject(row, 'Malformed v2 finality tags', { tags: tagsWith({ epoch: 'x' }) });
    case 'tier-out-of-range':
      return reject(row, 'Malformed v2 finality tags', { tags: tagsWith({ tier: '256' }) });
    case 'threshold-zero':
      return reject(row, 'Malformed v2 finality tags', { tags: tagsWith({ threshold: '0' }) });
    case 'signers-malformed':
      return reject(row, 'signers tag must be a 32-byte hex signer-set root', { tags: tagsWith({ signers: 'zz' }) });
    case 'outcome-too-long':
      return reject(row, 'v2 field bounds exceeded', { tags: tagsWith({ outcome: 'y'.repeat(257) }) });
    case 'market-too-long':
      return reject(row, 'v2 field bounds exceeded', { tags: tagsWith({ marketId: 'm'.repeat(1025) }) });
    case 'round-too-long':
      return reject(row, 'v2 field bounds exceeded', { tags: tagsWith({ round: '9'.repeat(65) }) });
    case 'wrong-kind':
      return reject(row, 'Not a Kind 89', { kind: 1 });
    case 'epoch-pin-mismatch':
    case 'tier-pin-mismatch':
    case 'threshold-pin-mismatch':
    case 'signers-pin-mismatch':
    case 'signer-set-size-mismatch':
    case 'batch-pin-mismatch': {
      // The EVENT is valid; the CONSUMER's pin is what rejects it. Each row
      // declares the error its own pin must produce.
      const expect: Record<string, string> = {
        'epoch-pin-mismatch': 'Epoch mismatch',
        'tier-pin-mismatch': 'below finality policy minimum',
        'threshold-pin-mismatch': 'below finality policy minimum',
        'signers-pin-mismatch': 'Signer-set root mismatch',
        'signer-set-size-mismatch': 'does not hash to the signers tag',
        'batch-pin-mismatch': 'Batch Merkle root mismatch',
      };
      return reject(row, expect[row]!);
    }
    case 'untrusted-publisher':
      return reject(row, 'Untrusted attestation publisher', { publisherSecret: strangerSecret });
    case 'dispute-missing-tag':
      return reject(row, 'Missing dispute tag on dispute attestation', {
        kind: BAO_COURT_ATTESTATION_KIND,
        tags: tagsWith({ omit: ['dispute'] }),
      });
    case 'dispute-verdict-forgery': {
      // The replacement digit must differ from the original — a no-op mutation
      // would leave a VALID event behind and the row would be vacuous.
      const forged = `${combo.verdictHash.slice(0, -1)}${combo.verdictHash.endsWith('0') ? '1' : '0'}`;
      return reject(row, 'Verdict hash does not match the dispute verdict inputs', {
        kind: BAO_COURT_ATTESTATION_KIND,
        tags: tagsWith({ verdict: forged }),
        content: contentFor(combo, { verdictHash: forged }),
      });
    }
    default:
      return accept('accept-fallback');
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
