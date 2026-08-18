// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * FrostAppealCoordinator — Just-in-time FROST threshold oracle appeal layer.
 *
 * Runs the JIT appeal protocol for disputed markets:
 *   1. Listen for Kind 38025 disputes tagged `appeal_type: frost`.
 *   2. Collect Kind 39001 juror candidacies during the opt-in window.
 *   3. Publish Kind 39002 selection event.
 *   4. Run DKG (Pedersen adapter by default; swappable adapter).
 *   5. Collect Kind 39004 commit/reveal votes.
 *   6. Run FROST signing round (Kinds 39005/39006).
 *   7. Publish Kind 39007 attestation.
 *
 * This is a single-process, event-driven coordinator intended for demo and
 * integration tests. Production jurors run independent nodes.
 *
 * Transport is host-injected: pass a `relayPool` (a nostr-tools
 * `SimplePool`-compatible object) plus `relayUrls` to publish/fetch events.
 * With no `relayPool` (or empty `relayUrls`) the coordinator still runs the
 * full ceremony in-process — events are signed but not broadcast.
 */

import type { Event as NostrEvent, Filter } from 'nostr-tools';
import {
  buildDisputeEvent,
  buildJurorCandidacyEvent,
  buildSelectionEvent,
  buildVoteCommitEvent,
  buildVoteRevealEvent,
  buildFrostCommitEvent,
  buildFrostRevealEvent,
  buildDisputeAttestationEvent,
  validateSelectionEvent,
  parseJurorCandidacyEvent,
} from './events';
import { selectJuryWithBackups, deriveSelectionSeed } from './selection';
import { generateFrostKeys, type KeygenResult, type KeygenParams } from './dkg';
import { createCommitments, createRevealsAndPartialSigs, aggregateAttestation, createDefaultNonceGuard } from './signing';
import { hashCommit, tallyVotes, deriveSimulatedRevealEventId } from './dispute';
import { hashDisputeVerdict } from './courtVoteMachine';
import { verifyBond, type BondVerifier } from './bondVerification';
import { buildAttestationMessage } from './crypto';
import { verifyRawSignature } from './validator';
import { bytesToHex } from '@noble/hashes/utils.js';
import { computePhaseBounds, getActivePhase, TEST_APPEAL_TIMINGS, DEFAULT_APPEAL_TIMINGS } from './appealTiming';
import type { AppealPhase, AppealTimings, DkgRecord, DisputeCase, FrostAttestation, JurorProfile, SelectedJuror, StakeCommitment } from './types';

export type FrostEnvironment = 'test' | 'demo' | 'prod';

export type FrostAppealPhase =
  | 'pending'
  | 'opt_in'
  | 'selection'
  | 'dkg'
  | 'vote_commit'
  | 'vote_reveal'
  | 'signing'
  | 'attestation_published'
  | 'settled'
  | 'refund';

export interface FrostAppealState {
  readonly disputeId: string;
  readonly marketId: string;
  readonly disputeCase: DisputeCase;
  readonly resolutionTimestamp: number;
  phase: FrostAppealPhase;
  candidacies: Map<string, JurorProfile>;
  selectedJurors?: SelectedJuror[];
  backupJurors?: SelectedJuror[];
  dkgRecord?: DkgRecord;
  shares?: { idx: number; seckey: string }[];
  voteCommits: Map<number, { outcome: string; salt: string }>;
  voteReveals: Map<number, { outcome: string; salt: string }>;
  /**
   * The tally winner (the Court's verdict) — the ONLY outcome the signing
   * round may attest. The challenger's `proposedOutcome` is a claim, not a
   * decision; signing it instead of the verdict would let the court attest
   * an outcome that lost the vote.
   */
  verdictOutcome?: string;
  /**
   * Dispute verdict commitment bound into the signed attestation message
   * (kind 39007). Computed at tally time and frozen before signing.
   */
  verdictHash?: string;
  /** Supporting reveal event ids of the attested verdict. */
  verdictSupportingEventIds?: readonly string[];
  attestation?: FrostAttestation;
  /** Number of selection attempts made for this appeal (initial selection = 1). */
  selectionAttempts: number;
  /** Pubkeys that have been selected before and must be excluded from reselection. */
  excludedSelectedPubkeys: string[];
  /** Unix seconds after which reselection is no longer allowed. */
  reselectionDeadline: number;
}

export type NostrEventSigner = (event: {
  kind: number;
  tags: string[][];
  content: string;
  created_at: number;
}) => Promise<NostrEvent>;

/**
 * Host-injected relay transport (a nostr-tools `SimplePool` satisfies this).
 * The package never opens sockets of its own.
 */
export interface FrostRelayPool {
  /** nostr-tools `SimplePool.publish` semantics: one promise per relay. */
  publish(relayUrls: string[], event: NostrEvent): Array<Promise<unknown>>;
  querySync(relayUrls: string[], filter: Filter): Promise<NostrEvent[]>;
}

export interface FrostAppealCoordinatorConfig {
  readonly relayUrls: string[];
  /** Host-injected relay transport. Without it the ceremony runs in-process
   *  only: events are signed but never published or fetched. */
  readonly relayPool?: FrostRelayPool;
  readonly environment: FrostEnvironment;
  readonly signer?: NostrEventSigner;
  readonly baoCourtSigner?: (event: { kind: number; tags: string[][]; content: string; created_at: number }) => Promise<NostrEvent>;
  readonly remoteSigner?: { signEvent(event: { kind: number; tags: string[][]; content: string; created_at: number }): Promise<NostrEvent> };
  readonly pollIntervalMs?: number;
  readonly timings?: AppealTimings;
  readonly dkgAdapter?: { readonly run: (params: KeygenParams) => KeygenResult };
  readonly jurySize?: number;
  readonly backupCount?: number;
  readonly minStakeSats?: number;
  /** Optional UTXO verifier used to confirm on-chain bond funding. */
  readonly bondVerifier?: BondVerifier;
  /**
   * Optional 32-byte hex block hash used as the jury-selection seed input.
   * Defaults to a CSPRNG draw; deployments with a real confirmed block hash
   * (see AppealTimings.seedBlockConfirmations) should supply it so the
   * published selection event is attributable to a public block.
   */
  readonly selectionBlockHash?: string;
  /** Async check that a stake commitment is valid for this market. */
  readonly verifyStakeCommitment?: (commitment: StakeCommitment) => Promise<boolean>;
}

export interface FrostAppealCoordinatorEvent {
  readonly type: string;
  readonly disputeId: string;
  readonly marketId: string;
  readonly phase: FrostAppealPhase;
  readonly data: Record<string, unknown>;
  readonly timestamp: number;
}

export interface FrostAppealCoordinator {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  getActiveAppeals(): FrostAppealState[];
  onEvent(callback: (event: FrostAppealCoordinatorEvent) => void): () => void;
  addAppeal(appeal: FrostAppealState): void;
  /**
   * Settle an appeal from a validated Kind 39007 attestation. Any watcher or
   * facilitator can call this once the threshold signature is public, removing
   * the need for a single trusted coordinator to drive the lifecycle.
   */
  settleAppeal(disputeId: string, attestation: FrostAttestation): boolean;
}

const KIND_DISPUTE = 38025;
const KIND_JUROR_CANDIDACY = 39001;
const KIND_SELECTION = 39002;
const KIND_DKG_COMMITMENT = 38031;
const KIND_VOTE = 39004;
const KIND_FROST_COMMIT = 39005;
const KIND_FROST_REVEAL = 39006;
const KIND_ATTESTATION = 39007;

export function createFrostAppealCoordinator(
  config: FrostAppealCoordinatorConfig,
): FrostAppealCoordinator {
  const appeals = new Map<string, FrostAppealState>();
  const listeners = new Set<(event: FrostAppealCoordinatorEvent) => void>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  const pollMs = config.pollIntervalMs ?? 5000;
  const timings = config.timings ?? (config.environment === 'test' ? TEST_APPEAL_TIMINGS : DEFAULT_APPEAL_TIMINGS);
  const dkgAdapter = config.dkgAdapter;
  const jurySize = config.jurySize ?? 5;
  const backupCount = config.backupCount ?? 2;
  const minStakeSats = config.minStakeSats ?? 10_000;
  async function defaultVerifyStakeCommitment(commitment: StakeCommitment): Promise<boolean> {
    if (commitment.amountSats < minStakeSats || commitment.bondAddress.length === 0) return false;
    const hasEvidence = Boolean(commitment.scriptPubKey && commitment.bondTxid && commitment.bondVout !== undefined);
    if (!hasEvidence) {
      // Fail closed where a bond can actually be verified: an assertion of
      // on-chain funding without evidence must not admit a juror when a bond
      // verifier is wired (or in prod). Demo/test without a verifier has no
      // on-chain claim to assert, so it stays permissive — but never prod.
      if (config.bondVerifier || config.environment === 'prod') return false;
      return true;
    }
    if (!config.bondVerifier) return false;
    const result = await verifyBond({
      commitment,
      expectedScriptPubKey: commitment.scriptPubKey,
      minAmountSats: minStakeSats,
      verifier: config.bondVerifier,
    });
    // TODO(court): the claimed UTXO's scriptPubKey is self-attested and there
    // is still no proof the candidate OWNS the output (a challenge signature
    // over bondTxid/bondVout with the UTXO key). Add an ownership proof to the
    // candidacy protocol before any mainnet deployment.
    return result.valid;
  }
  const verifyStakeCommitment = config.verifyStakeCommitment ?? defaultVerifyStakeCommitment;

  function emit(
    type: string,
    appeal: FrostAppealState,
    data: Record<string, unknown> = {},
  ): void {
    const event: FrostAppealCoordinatorEvent = {
      type,
      disputeId: appeal.disputeId,
      marketId: appeal.marketId,
      phase: appeal.phase,
      data,
      timestamp: Date.now(),
    };
    for (const cb of listeners) {
      try { cb(event); } catch { /* listener error — don't crash */ }
    }
  }

  async function getSignerFn(): Promise<NostrEventSigner> {
    if (config.signer) return config.signer;
    const nip07 = (globalThis as { nostr?: { signEvent(e: { kind: number; tags: string[][]; content: string; created_at: number }): Promise<NostrEvent> } }).nostr;
    if (nip07?.signEvent) {
      return async (e) => nip07.signEvent(e);
    }
    throw new Error('No signer available');
  }

  async function publishEvent(template: { kind: number; tags: string[][]; content: string }): Promise<NostrEvent> {
    const unsigned = { ...template, created_at: Math.floor(Date.now() / 1000) };
    let signed: NostrEvent;

    if (config.remoteSigner) {
      signed = await config.remoteSigner.signEvent(unsigned);
    } else if (config.baoCourtSigner) {
      signed = await config.baoCourtSigner(unsigned);
    } else {
      const sign = await getSignerFn();
      signed = await sign(unsigned);
    }

    if (config.relayUrls.length === 0 || !config.relayPool) {
      if (config.relayUrls.length > 0 && !config.relayPool) {
        console.warn('[FrostAppealCoordinator] relayUrls set but no relayPool injected — event signed, not published:', signed.id);
      }
      return signed;
    }

    const results = await Promise.allSettled(config.relayPool.publish(config.relayUrls, signed));
    const published = results.some((r) => r.status === 'fulfilled');
    if (!published) {
      console.warn('[FrostAppealCoordinator] No relay acknowledged event:', signed.id);
    }
    return signed;
  }

  async function fetchRelayEvents(kinds: number[], filters: Partial<Filter> = {}): Promise<NostrEvent[]> {
    if (config.relayUrls.length === 0 || !config.relayPool) {
      return [];
    }
    const filter: Filter = { kinds, limit: 200, ...filters };
    try {
      return await config.relayPool.querySync(config.relayUrls, filter) as unknown as NostrEvent[];
    } catch (err) {
      console.warn('[FrostAppealCoordinator] Relay fetch error:', err);
      return [];
    }
  }

  function computeReselectionDeadline(appeal: FrostAppealState): number {
    return appeal.resolutionTimestamp
      + timings.disputeWindowSeconds
      + timings.optInWindowSeconds
      + timings.reselectionWindowSeconds;
  }

  function releaseBackupStakes(appeal: FrostAppealState): void {
    const backupPubkeys = (appeal.backupJurors ?? []).map((j) => j.nostrPubkey);
    if (backupPubkeys.length > 0) {
      emit('backup_stakes_released', appeal, { backupPubkeys });
    }
  }

  function moveToRefund(appeal: FrostAppealState, reason: string, error: string): void {
    releaseBackupStakes(appeal);
    appeal.phase = 'refund';
    emit('reselection_exhausted', appeal, { reason, error });
  }

  function maybeReselect(appeal: FrostAppealState, failureType: string, error: Error): void {
    const now = Math.floor(Date.now() / 1000);
    if (now < appeal.reselectionDeadline) {
      for (const j of appeal.selectedJurors ?? []) {
        appeal.excludedSelectedPubkeys.push(j.nostrPubkey);
      }
      appeal.selectionAttempts += 1;
      appeal.selectedJurors = undefined;
      // Keep backupJurors — they are the pool for reselection and are released
      // only when the appeal terminates (settled or exhausted).
      appeal.dkgRecord = undefined;
      appeal.shares = undefined;
      appeal.voteCommits = new Map();
      appeal.voteReveals = new Map();
      appeal.attestation = undefined;
      appeal.phase = 'selection';
      emit('reselection_started', appeal, {
        attempt: appeal.selectionAttempts,
        reason: failureType,
        error: error.message,
      });
    } else {
      moveToRefund(appeal, failureType, error.message);
    }
  }

  async function processAppeal(appeal: FrostAppealState): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const phase = getActivePhase(appeal.resolutionTimestamp, now, timings);

    switch (appeal.phase) {
      case 'pending': {
        appeal.phase = 'opt_in';
        emit('opt_in_window_opened', appeal, {
          deadline: appeal.resolutionTimestamp + timings.disputeWindowSeconds + timings.optInWindowSeconds,
        });
        break;
      }

      case 'opt_in': {
        // Fetch candidacies.
        const events = await fetchRelayEvents([KIND_JUROR_CANDIDACY], {
          '#dispute': [appeal.disputeId],
        });
        for (const event of events) {
          const profile = parseJurorCandidacyEvent(event);
          if (!profile) {
            continue;
          }
          const valid = await verifyStakeCommitment(profile.stakeCommitment);
          if (!valid) {
            continue;
          }
          // The coordinator is the admission authority: a candidate whose stake
          // commitment passed verification is admitted with a confirmed status
          // for jury selection (parseJurorCandidacyEvent no longer fabricates
          // confirmation itself). In prod, verification requires on-chain
          // evidence; in demo/test without a verifier it is the configured
          // acceptance policy.
          appeal.candidacies.set(event.pubkey, {
            ...profile,
            stakeCommitment: {
              ...profile.stakeCommitment,
              status: 'confirmed',
            },
          });
        }

        if (phase === 'selection' || appeal.candidacies.size >= jurySize + backupCount) {
          if (!appeal.reselectionDeadline || appeal.reselectionDeadline <= now) {
            appeal.reselectionDeadline = computeReselectionDeadline(appeal);
          }
          appeal.phase = 'selection';
          emit('candidacies_collected', appeal, { count: appeal.candidacies.size });
        }
        break;
      }

      case 'selection': {
        const pool = Array.from(appeal.candidacies.values());
        try {
          // ONE seed input for both the draw and the published event: the
          // event must reproduce the draw (verifyJurySelection) or the
          // selection is unauditable. Previously each used a separate
          // Math.random hash, so the published event could never verify.
          const seedBlockHash = config.selectionBlockHash ?? randomBlockHash();
          const { selected, backups } = selectJuryWithBackups(pool, {
            disputeEventId: appeal.disputeId,
            blockHash: seedBlockHash,
            marketCategory: 'bitcoin',
            marketVolumeSats: 1_000_000,
            jurySize,
            backupCount,
            minStakeSats,
            excludedPubkeys: appeal.excludedSelectedPubkeys,
          });
          appeal.selectedJurors = selected;
          appeal.backupJurors = backups;

          const coordinatorPubkey = randomBytesHex(32);
          const selectionEvent = buildSelectionEvent({
            disputeId: appeal.disputeId,
            marketId: appeal.marketId,
            selectedJurors: selected.map((j) => ({ idx: j.idx, pubkey: j.nostrPubkey, stake: j.stakeCapacitySats })),
            backupJurors: backups.map((j) => ({ idx: j.idx, pubkey: j.nostrPubkey, stake: j.stakeCapacitySats })),
            // Exact inputs the draw used: the canonical seed (sha256 of
            // disputeEventId || blockHash) and the same blockHash.
            seed: bytesToHex(deriveSelectionSeed(appeal.disputeId, seedBlockHash)),
            blockHash: seedBlockHash,
            publisherPubkey: coordinatorPubkey,
          });
          await publishEvent(selectionEvent);

          appeal.phase = 'dkg';
          emit('jury_selected', appeal, {
            selected: selected.length,
            backups: backups.length,
            attempt: appeal.selectionAttempts + 1,
          });
        } catch (err) {
          const error = err as Error;
          if (appeal.selectionAttempts > 0) {
            moveToRefund(appeal, 'selection_failed', error.message);
          } else {
            emit('selection_failed', appeal, { error: error.message });
          }
        }
        break;
      }

      case 'dkg': {
        if (!appeal.selectedJurors) break;
        const threshold = Math.ceil(appeal.selectedJurors.length * 0.6);
        const keygenParams = {
          marketId: appeal.marketId,
          threshold,
          jurors: appeal.selectedJurors,
        };
        try {
          const result = dkgAdapter ? dkgAdapter.run(keygenParams) : generateFrostKeys(keygenParams);
          appeal.dkgRecord = result.record;
          appeal.shares = result.shares.map((s: { idx: number; seckey: string }) => ({ idx: s.idx, seckey: s.seckey }));
          appeal.phase = 'vote_commit';
          emit('dkg_complete', appeal, { groupPubkey: result.record.groupPubkeyXOnly });
        } catch (err) {
          maybeReselect(appeal, 'dkg_failed', err as Error);
        }
        break;
      }

      case 'vote_commit': {
        if (!appeal.selectedJurors) break;
        // In a real implementation, selected jurors publish Kind 39004 commits.
        // For the coordinator demo we simulate them from shares so the flow is self-contained.
        const proposedOutcome = appeal.disputeCase.proposedOutcome;
        for (const juror of appeal.selectedJurors) {
          const salt = randomBytesHex(16);
          appeal.voteCommits.set(juror.idx, { outcome: proposedOutcome, salt });
        }
        appeal.phase = 'vote_reveal';
        emit('vote_commits_collected', appeal, { count: appeal.voteCommits.size });
        break;
      }

      case 'vote_reveal': {
        if (!appeal.selectedJurors) break;
        for (const [idx, commit] of appeal.voteCommits.entries()) {
          appeal.voteReveals.set(idx, commit);
        }

        const votes = appeal.selectedJurors.map((j) => {
          const reveal = appeal.voteReveals.get(j.idx);
          return {
            idx: j.idx,
            pubkey: j.nostrPubkey,
            commit: reveal ? hashCommit(reveal.outcome, reveal.salt) : '',
            reveal,
          };
        });
        const verdict = tallyVotes(votes);
        appeal.verdictOutcome = verdict.outcome;
        // Freeze the dispute verdict commitment BEFORE signing. This demo runs
        // the vote in-process, so supporting reveals have no Nostr event ids;
        // derive deterministic synthetic ones (production uses the real
        // kind-39014 reveal event ids — same commitment structure).
        const supportingEventIds = verdict.supportingVotes.map((v) =>
          deriveSimulatedRevealEventId(v.idx, v.reveal!.outcome, v.reveal!.salt),
        );
        appeal.verdictHash = hashDisputeVerdict({
          disputeId: appeal.disputeId,
          outcome: verdict.outcome,
          supportingEventIds,
        });
        appeal.verdictSupportingEventIds = supportingEventIds;
        appeal.phase = 'signing';
        emit('vote_reveals_collected', appeal, {
          verdict: verdict.outcome,
          supportingVotes: verdict.supportingVotes.length,
        });
        break;
      }

      case 'signing': {
        if (!appeal.dkgRecord || !appeal.shares) break;
        try {
          const signingShares = appeal.shares.slice(0, appeal.dkgRecord.threshold);
          const nonceGuard = createDefaultNonceGuard(`bao-frost-used-nonces|${appeal.disputeId}`);
          // The court attests the TALLY WINNER — never the challenger's
          // proposed outcome. `verdictOutcome` is set when the tally runs;
          // the fallback is defensive only.
          const outcome = appeal.verdictOutcome ?? appeal.disputeCase.proposedOutcome;
          const commitments = createCommitments(signingShares);
          const reveals = createRevealsAndPartialSigs(
            {
              marketId: appeal.marketId,
              outcome,
              round: 1,
              disputeEventId: appeal.disputeId,
              verdictHash: appeal.verdictHash,
              dkg: appeal.dkgRecord,
              shares: signingShares,
              nonceGuard,
            },
            commitments,
          );
          const attestation = aggregateAttestation(
            {
              marketId: appeal.marketId,
              outcome,
              round: 1,
              disputeEventId: appeal.disputeId,
              verdictHash: appeal.verdictHash,
              dkg: appeal.dkgRecord,
              shares: signingShares,
              nonceGuard,
            },
            commitments,
            reveals,
          );
          const disputeAttestation: FrostAttestation = {
            ...attestation,
            kind: 39007,
            disputeEventId: appeal.disputeId,
            verdictHash: appeal.verdictHash,
            supportingEventIds: appeal.verdictSupportingEventIds,
          };
          appeal.attestation = disputeAttestation;

          const attestationEvent = buildDisputeAttestationEvent({
            attestation: disputeAttestation,
            marketEventId: appeal.marketId,
          });
          await publishEvent(attestationEvent);

          appeal.phase = 'attestation_published';
          emit('attestation_published', appeal, {
            attestationEventId: attestationEvent.kind,
            outcome: disputeAttestation.outcome,
          });
        } catch (err) {
          maybeReselect(appeal, 'signing_failed', err as Error);
        }
        break;
      }

      case 'attestation_published': {
        releaseBackupStakes(appeal);
        appeal.phase = 'settled';
        emit('appeal_settled', appeal, {
          outcome: appeal.attestation?.outcome,
          groupPubkey: appeal.dkgRecord?.groupPubkeyXOnly,
        });
        break;
      }

      case 'settled':
        // terminal
        break;

      case 'refund':
        // terminal — backup stakes were released when transitioning here
        break;
    }
  }

  async function pollCycle(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      // Fetch new FROST appeals
      const disputeEvents = await fetchRelayEvents([KIND_DISPUTE], {
        '#appeal_type': ['frost'],
      });
      for (const event of disputeEvents) {
        if (appeals.has(event.id)) continue;

        const marketTag = event.tags.find((t) => t[0] === 'market')?.[1] ?? event.tags.find((t) => t[0] === 'e')?.[1];
        if (!marketTag) continue;

        const proposedTag = event.tags.find((t) => t[0] === 'proposed')?.[1];
        const originalTag = event.tags.find((t) => t[0] === 'original')?.[1];
        const evidenceTags = event.tags.filter((t) => t[0] === 'evidence').map((t) => t[1]);

        let content: Record<string, unknown> = {};
        try { content = JSON.parse(event.content); } catch { /* ignore */ }

        const disputeCase: DisputeCase = {
          disputeId: event.id,
          marketId: marketTag,
          challengerPubkey: event.pubkey,
          respondentPubkey: typeof content.respondentPubkey === 'string' ? content.respondentPubkey : randomBytesHex(32),
          evidenceHashes: evidenceTags,
          proposedOutcome: proposedTag ?? (typeof content.proposedOutcome === 'string' ? content.proposedOutcome : ''),
        };

        const appeal: FrostAppealState = {
          disputeId: event.id,
          marketId: marketTag,
          disputeCase,
          resolutionTimestamp: event.created_at,
          phase: 'pending',
          candidacies: new Map(),
          voteCommits: new Map(),
          voteReveals: new Map(),
          selectionAttempts: 0,
          excludedSelectedPubkeys: [],
          reselectionDeadline: event.created_at + timings.disputeWindowSeconds + timings.optInWindowSeconds + timings.reselectionWindowSeconds,
        };

        appeals.set(event.id, appeal);
        emit('appeal_detected', appeal, { disputerPubkey: event.pubkey });
      }

      for (const appeal of appeals.values()) {
        if (appeal.phase !== 'settled' && appeal.phase !== 'refund') {
          await processAppeal(appeal);
        }
      }
    } catch (err) {
      console.error('[FrostAppealCoordinator] Poll cycle error:', err);
    } finally {
      polling = false;
    }
  }

  function randomBytesHex(n: number): string {
    // CSPRNG, not Math.random: this feeds the jury-selection seed and the
    // sponsorship identity. Math.random output is predictably biased and
    // must never be used for draw inputs. (Node >= 19 and all browsers
    // expose the WebCrypto global.)
    if (typeof globalThis === 'undefined' || typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
      throw new Error('No CSPRNG (crypto.getRandomValues) available for Court coordinator');
    }
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomBlockHash(): string {
    return randomBytesHex(32);
  }

  return {
    start() {
      if (intervalId) return;
      void pollCycle();
      intervalId = setInterval(() => void pollCycle(), pollMs);
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      appeals.clear();
      listeners.clear();
    },
    async tick() {
      await pollCycle();
    },
    getActiveAppeals() {
      return Array.from(appeals.values());
    },
    onEvent(callback) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    addAppeal(appeal) {
      if (appeal.selectionAttempts === undefined) {
        appeal.selectionAttempts = 0;
      }
      if (appeal.excludedSelectedPubkeys === undefined) {
        appeal.excludedSelectedPubkeys = [];
      }
      if (appeal.reselectionDeadline === undefined) {
        appeal.reselectionDeadline = computeReselectionDeadline(appeal);
      }
      appeals.set(appeal.disputeId, appeal);
    },
    settleAppeal(disputeId, attestation) {
      const appeal = appeals.get(disputeId);
      if (!appeal) return false;
      if (appeal.phase === 'settled' || appeal.phase === 'refund') {
        return false;
      }
      // Validate BEFORE settling — mirror FrostAppealWatcher's checks. An
      // unvalidated attestation here would let any facilitator settle an
      // appeal with forged data (no signature, wrong dispute/market/outcome).
      if (attestation.disputeEventId !== disputeId) {
        emit('settlement_rejected', appeal, { reason: 'dispute_mismatch' });
        return false;
      }
      if (attestation.marketId !== appeal.marketId) {
        emit('settlement_rejected', appeal, { reason: 'market_mismatch' });
        return false;
      }
      // The attestation message must be exactly what a FROST round for this
      // dispute/market/outcome would sign. Pre-#799 attestations do not carry
      // `round` (the codebase convention is round 1); post-#799 they do. Try
      // the carried round first, then the legacy constant.
      // Dispute attestations MUST bind the dispute verdict commitment — the
      // signature certifies the tally, not just an outcome.
      if (!attestation.verdictHash || !/^[0-9a-f]{64}$/.test(attestation.verdictHash)) {
        emit('settlement_rejected', appeal, { reason: 'missing_verdict_hash' });
        return false;
      }
      const carriedRound = (attestation as { round?: number | string }).round;
      const roundsToTry =
        carriedRound !== undefined && carriedRound !== null
          ? [String(carriedRound)]
          : ['1'];
      const messageMatches = roundsToTry.some(
        (r) =>
          attestation.message ===
          buildAttestationMessage(
            attestation.marketId,
            attestation.outcome,
            r,
            disputeId,
            attestation.verdictHash,
          ),
      );
      if (!messageMatches) {
        emit('settlement_rejected', appeal, { reason: 'message_does_not_bind_verdict' });
        return false;
      }
      if (
        typeof attestation.signature !== 'string'
        || typeof attestation.groupPubkey !== 'string'
        || !verifyRawSignature(attestation.groupPubkey, attestation.message, attestation.signature)
      ) {
        emit('settlement_rejected', appeal, { reason: 'invalid_signature' });
        return false;
      }
      // When this coordinator ran the DKG itself, the settling attestation
      // must come from that exact group key.
      if (appeal.dkgRecord && attestation.groupPubkey !== appeal.dkgRecord.groupPubkeyXOnly) {
        emit('settlement_rejected', appeal, { reason: 'group_key_mismatch' });
        return false;
      }
      releaseBackupStakes(appeal);
      appeal.attestation = attestation;
      appeal.phase = 'settled';
      emit('appeal_settled_from_attestation', appeal, {
        outcome: attestation.outcome,
        groupPubkey: attestation.groupPubkey,
        eventId: attestation.disputeEventId,
      });
      return true;
    },
  };
}
