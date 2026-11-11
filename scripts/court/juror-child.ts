// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Juror child process for `scripts/court/multi-process-ceremony.mjs`.
 *
 * One OS process = one juror: its own PID, heap, identity, and state dir. It
 * speaks a real HTTP/JSON protocol to the relay the coordinator hosts (a
 * third party that assigns message order), drives the production
 * `IndependentDkgSession` → `IndependentSigningSession` pipeline, and reports
 * a machine-readable outcome on stdout (`REPORT <json>`).
 *
 * Everything on the wire is a SIGNED Nostr event; peers re-parse it with the
 * production parsers (`parseDkgCommitmentEvent`, `parseEncryptedShareEvent`,
 * `parseFrostCommitEvent`, `parseFrostRevealEvent`) and feed it to the
 * session classes' gates. The outer envelope (`round`, `phase`) is NOT
 * authenticated — that is deliberate, so a replayer can re-label stale
 * messages into a new round and be judged by the signature-bearing payload
 * alone (exactly the production threat).
 *
 * Fail-closed contract: this process never emits an aggregate it could not
 * verify, and never emits a partial signature for a round it aborted. When it
 * cannot finish it publishes a typed classification and exits 0 with
 * `ok:false` so the coordinator can assert *why* it failed.
 */

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { scalarToHex, seededScalar, deriveXOnlyPubkey, verifyFinalSignature } from '../../crypto';
import { IndependentDkgSession } from '../../independentDkg';
import { IndependentSigningSession } from '../../independentSigning';
import {
  parseDkgCommitmentEvent,
  parseFrostCommitEvent,
  parseFrostRevealEvent,
} from '../../eventsParse';
import { parseEncryptedShareEvent } from '../../dkgMessages';
import type { SelectedJuror } from '../../types';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
}

const relayUrl = arg('relay');
const myIdx = Number(arg('idx'));
const jurorCount = Number(arg('jurors'));
const threshold = Number(arg('threshold'));
const seedHex = arg('seed');
const stateDir = arg('dir');
const rounds = Number(arg('rounds', '1'));
/** 1-based round whose messages this juror replays into the NEXT round. */
const replayRound = Number(arg('replay-round', '0'));
const dkgDeadlineMs = Number(arg('dkg-deadline-ms', '10000'));
const signDeadlineMs = Number(arg('sign-deadline-ms', '10000'));
const pollMs = Number(arg('poll-ms', '20'));
/** Deterministic pre-publish jitter so processes genuinely interleave. */
const publishGapMs = Number(arg('publish-gap-ms', '150'));

const runDir = join(stateDir, `juror-${myIdx}`);
mkdirSync(runDir, { recursive: true });
const publishedLog = join(runDir, 'published.jsonl');

const encoder = new TextEncoder();

/**
 * Identity: derived deterministically from the ceremony seed so every
 * process computes the same roster without a trust handshake. A simulation
 * convenience — production rosters come from a signed selection event.
 */
function identityFor(idx: number): { seckey: Uint8Array; pubkey: string } {
  const seckeyHex = scalarToHex(
    seededScalar(hexToBytes(seedHex), encoder.encode(`r30/juror/${idx}`)),
  );
  const seckey = hexToBytes(seckeyHex);
  return { seckey, pubkey: deriveXOnlyPubkey(seckeyHex) };
}

const me = identityFor(myIdx);

function roster(): SelectedJuror[] {
  return Array.from({ length: jurorCount }, (_, i) => {
    const idx = i + 1;
    const pubkey = idx === myIdx ? me.pubkey : identityFor(idx).pubkey;
    return {
      idx,
      nostrPubkey: pubkey,
      stakeCapacitySats: 10_000,
      stakeCommitment: {
        amountSats: 10_000,
        bondAddress: 'sim-bond',
        status: 'confirmed',
        committedAt: 1_700_000_000,
      },
      wotScore: 80,
      categories: ['world'],
      registeredAt: 1_700_000_000,
      priority: idx,
    } as SelectedJuror;
  });
}

// ---------------------------------------------------------------------------
// Relay client (real HTTP over loopback TCP)
// ---------------------------------------------------------------------------

interface Envelope {
  readonly round: number;
  readonly phase: string;
  readonly from: number;
  readonly event?: NostrEvent;
  readonly payload?: Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `as=<idx>` is how the relay knows WHICH juror is polling. That is not a
 * concession to the simulation: a real relay sees a distinct connection per
 * subscriber and can serve each one a different view (eclipse / split-view).
 * Declaring it makes the per-juror view explicit and reproducible instead of
 * hidden in connection bookkeeping.
 */
async function publish(envelope: Envelope): Promise<number> {
  const response = await fetch(`${relayUrl}/events?as=${myIdx}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`relay publish failed: ${response.status}`);
  const { seq } = (await response.json()) as { seq: number };
  appendFileSync(publishedLog, JSON.stringify({ seq, envelope }) + '\n');
  return seq;
}

async function poll(cursor: number): Promise<{ messages: (Envelope & { seq: number })[]; next: number }> {
  const response = await fetch(`${relayUrl}/events?since=${cursor}&as=${myIdx}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`relay poll failed: ${response.status}`);
  return (await response.json()) as { messages: (Envelope & { seq: number })[]; next: number };
}

/** Deterministic, phase-specific jitter: the ordering is set by the relay. */
function jitter(round: number, phaseIndex: number): number {
  return (myIdx * 13 + round * 29 + phaseIndex * 7) % 41;
}

// ---------------------------------------------------------------------------
// One ceremony round
// ---------------------------------------------------------------------------

interface RoundOutcome {
  readonly round: number;
  readonly ok: boolean;
  readonly classification?: string;
  readonly blamedIdx?: number;
  readonly groupPubkeyXOnly?: string;
  readonly signature?: string;
  readonly message?: string;
  readonly signatureVerifies?: boolean;
  readonly disclosure?: Record<string, unknown>;
}

function disputeIdFor(round: number): string {
  // ONE dispute for the whole run: an outer "round" label is an unauthenticated
  // envelope field, exactly like a relay-delivered event's arrival time. Two
  // ROUNDS over the same dispute is the real retry/replay vector — that is
  // what `phaseNonce` (the attempt binding carried inside the signed
  // commitment) has to defend.
  void round;
  return bytesToHex(sha256(encoder.encode(`r30/dispute/${seedHex}`)));
}

async function runRound(
  round: number,
  captured: Map<number, Envelope[]>,
): Promise<RoundOutcome> {
  const disputeId = disputeIdFor(round);
  const jurors = roster();
  const dkg = new IndependentDkgSession({
    disputeId,
    myIdx,
    myPubkey: me.pubkey,
    mySeckey: me.seckey,
    threshold,
    jurors,
  });

  // Receive-side bookkeeping (this process's own view, used for blame).
  const sawCommitment = new Set<number>();
  const sawShare = new Set<number>();
  const rejected = new Set<number>();
  const myMessages: Envelope[] = [];
  // Relay-side replay evidence: an event id this process has already ingested
  // in THIS round. Idempotent re-delivery must be a no-op — never a second
  // accepted commitment and never a second partial signature.
  const seenEventIds = new Set<string>();
  let duplicateDeliveries = 0;
  const noteDelivery = (eventId: string | undefined): void => {
    if (!eventId) return;
    if (seenEventIds.has(eventId)) duplicateDeliveries += 1;
    else seenEventIds.add(eventId);
  };

  const send = async (envelope: Envelope): Promise<void> => {
    myMessages.push(envelope);
    await publish(envelope);
  };

  // Cross-round replay attack surface: re-publish this juror's captured round
  // bytes under the CURRENT round's envelope before publishing live traffic.
  let replayedCount = 0;
  if (replayRound !== 0 && round === replayRound + 1) {
    for (const stale of captured.get(replayRound) ?? []) {
      if (stale.phase === 'report') continue;
      await send({ round, phase: stale.phase, from: stale.from, event: stale.event });
      replayedCount += 1;
    }
  }

  // ── DKG round 1: commit + encrypted shares ────────────────────────────────
  const { commitmentEvent, shareEvents } = await dkg.generateCommitmentAndShares();
  const signedCommitment = finalizeEvent(commitmentEvent as EventTemplate, me.seckey);
  await sleep(jitter(round, 0));
  await send({ round, phase: 'dkg-commit', from: myIdx, event: signedCommitment });
  await sleep(publishGapMs);
  for (const shareEvent of shareEvents) {
    await send({
      round,
      phase: 'dkg-share',
      from: myIdx,
      event: finalizeEvent(shareEvent as EventTemplate, me.seckey),
    });
  }

  // ── Collect until the key is computable or the phase deadline passes ──────
  const ingestDkg = async (envelope: Envelope & { seq: number }): Promise<boolean> => {
    if (!envelope.event) return false;
    if (envelope.phase === 'dkg-commit') {
      const parsed = parseDkgCommitmentEvent(envelope.event);
      if (!parsed) return false;
      if (parsed.jurorIdx === myIdx) return false;
      const accepted = dkg.addCommitment({
        idx: parsed.jurorIdx,
        pubkey: parsed.jurorPubkey,
        threshold: parsed.threshold,
        vssCommits: parsed.vssCommits,
        pok: parsed.pok,
        phaseNonce: parsed.phaseNonce,
        eventId: envelope.event.id,
      });
      if (accepted) sawCommitment.add(parsed.jurorIdx);
      else {
        // A false here on a roster member is either a byte-identical repeat
        // (harmless — idempotent) or an equivocation/rejection (fatal).
        const duplicate = sawCommitment.has(parsed.jurorIdx);
        if (duplicate) rejected.add(parsed.jurorIdx);
      }
      return accepted;
    }
    if (envelope.phase === 'dkg-share') {
      const payload = parseEncryptedShareEvent(envelope.event);
      if (!payload || payload.toIdx !== myIdx) return false;
      const accepted = dkg.addEncryptedShare(payload, envelope.event.pubkey);
      if (accepted) sawShare.add(payload.fromIdx);
      else if (sawShare.has(payload.fromIdx)) rejected.add(payload.fromIdx);
      return accepted;
    }
    return false;
  };

  const dkgDeadline = Date.now() + dkgDeadlineMs;
  let cursor = 0;
  let record = null;
  while (Date.now() < dkgDeadline) {
    const { messages, next } = await poll(cursor);
    cursor = next;
    let fresh = 0;
    for (const message of messages) {
      if (message.round !== round) continue;
      if (message.from === myIdx) continue;
      noteDelivery(message.event?.id);
      if (message.phase === 'dkg-commit' || message.phase === 'dkg-share') {
        if (await ingestDkg(message)) fresh += 1;
      }
    }
    await dkg.decryptShares();
    if (dkg.canComputeKey()) {
      try {
        record = dkg.computeKey();
        break;
      } catch (error) {
        // computeKey tolerates nothing: a disqualified or missing roster
        // member is a consensus-level abort.
        return {
          round,
          ok: false,
          classification: 'DKG_DISQUALIFIED',
          blamedIdx: [...rejected][0],
          disclosure: { error: (error as Error).message.slice(0, 200), duplicatesSeen: duplicateDeliveries },
        };
      }
    }
    if (fresh === 0) await sleep(pollMs);
  }

  if (!record) {
    const missing: number[] = [];
    for (const j of jurors) {
      if (j.idx === myIdx) continue;
      if (!sawCommitment.has(j.idx) || !sawShare.has(j.idx)) missing.push(j.idx);
    }
    if (rejected.size > 0) {
      return {
        round,
        ok: false,
        classification: 'DKG_DISQUALIFIED',
        blamedIdx: Math.min(...rejected),
        disclosure: {
          rejectedIdx: [...rejected].sort((a, b) => a - b),
          sawCommitment: [...sawCommitment].sort((a, b) => a - b),
          sawShare: [...sawShare].sort((a, b) => a - b),
          replayedMessages: replayedCount,
          duplicatesSeen: duplicateDeliveries,
        },
      };
    }
    return {
      round,
      ok: false,
      classification: 'DKG_MISSING_PARTICIPANT',
      blamedIdx: missing.length > 0 ? Math.min(...missing) : undefined,
      disclosure: {
        missingIdx: missing.sort((a, b) => a - b),
        sawCommitment: [...sawCommitment].sort((a, b) => a - b),
        sawShare: [...sawShare].sort((a, b) => a - b),
        duplicatesSeen: duplicateDeliveries,
      },
    };
  }

  // ── Signing: commitment → reveal → aggregate ──────────────────────────────
  const share = dkg.getShare();
  const signing = new IndependentSigningSession({
    disputeId,
    myIdx,
    myPubkey: me.pubkey,
    dkg: record,
    outcome: 'YES',
    round: 1,
  });
  const { event: commitTemplate } = signing.createMyCommitment(share);
  await sleep(jitter(round, 1));
  await send({
    round,
    phase: 'frost-commit',
    from: myIdx,
    event: finalizeEvent(commitTemplate as EventTemplate, me.seckey),
  });

  const committed = new Set<number>([myIdx]);
  const revealed = new Set<number>();
  const signDeadline = Date.now() + signDeadlineMs;
  let attestation = null;
  while (Date.now() < signDeadline) {
    const { messages, next } = await poll(cursor);
    cursor = next;
    let fresh = 0;
    for (const message of messages) {
      if (message.round !== round || message.from === myIdx || !message.event) continue;
      noteDelivery(message.event.id);
      if (message.phase === 'frost-commit') {
        const parsed = parseFrostCommitEvent(message.event);
        if (!parsed) continue;
        if (signing.addCommitment({
          idx: parsed.jurorIdx,
          pubkey: parsed.pubkey,
          commitmentPackage: parsed.commitmentPackage,
        })) {
          committed.add(parsed.jurorIdx);
          fresh += 1;
        }
      } else if (message.phase === 'frost-reveal') {
        const parsed = parseFrostRevealEvent(message.event);
        if (!parsed) continue;
        if (signing.addReveal({
          idx: parsed.jurorIdx,
          pubkey: parsed.frostPubkey,
          publicNonce: parsed.publicNonce,
          partialSig: parsed.partialSig,
        })) {
          revealed.add(parsed.jurorIdx);
          fresh += 1;
        }
      }
    }
    if (signing.hasEnoughCommitments() && !revealed.has(myIdx)) {
      const { event: revealTemplate } = signing.createMyReveal(share);
      await send({
        round,
        phase: 'frost-reveal',
        from: myIdx,
        event: finalizeEvent(revealTemplate as EventTemplate, me.seckey),
      });
      revealed.add(myIdx);
    }
    if (signing.canAggregate()) {
      attestation = signing.aggregate();
      break;
    }
    if (fresh === 0) await sleep(pollMs);
  }

  if (!attestation) {
    const missingCommits: number[] = [];
    for (const j of jurors) {
      if (!committed.has(j.idx)) missingCommits.push(j.idx);
    }
    const missingReveals: number[] = [];
    for (const idx of committed) {
      if (!revealed.has(idx)) missingReveals.push(idx);
    }
    return {
      round,
      ok: false,
      classification: missingCommits.length > 0 ? 'SIGN_MISSING_PARTICIPANT' : 'SIGN_MISSING_REVEAL',
      blamedIdx: missingCommits.length > 0
        ? Math.min(...missingCommits)
        : Math.min(...missingReveals),
      groupPubkeyXOnly: record.groupPubkeyXOnly,
      disclosure: {
        committed: [...committed].sort((a, b) => a - b),
        revealed: [...revealed].sort((a, b) => a - b),
        missingCommits: missingCommits.sort((a, b) => a - b),
        missingReveals: missingReveals.sort((a, b) => a - b),
        duplicatesSeen: duplicateDeliveries,
      },
    };
  }

  const verifies = verifyFinalSignature(
    record.groupPubkeyXOnly,
    attestation.message,
    attestation.signature,
  );

  captured.set(round, myMessages);
  return {
    round,
    ok: verifies,
    classification: verifies ? 'OK' : 'SIGNATURE_INVALID',
    groupPubkeyXOnly: record.groupPubkeyXOnly,
    signature: attestation.signature,
    message: attestation.message,
    signatureVerifies: verifies,
    disclosure: {
      committed: [...committed].sort((a, b) => a - b),
      replayedMessages: replayedCount,
      duplicatesSeen: duplicateDeliveries,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const captured = new Map<number, Envelope[]>();
const outcomes: RoundOutcome[] = [];
for (let round = 1; round <= rounds; round += 1) {
  const outcome = await runRound(round, captured);
  outcomes.push(outcome);
  // Report over the wire too, so the coordinator can observe progress live.
  await publish({ round, phase: 'report', from: myIdx, payload: outcome as unknown as Record<string, unknown> });
  process.stdout.write(`REPORT ${JSON.stringify(outcome)}\n`);
}

writeFileSync(join(runDir, 'outcomes.json'), JSON.stringify(outcomes, null, 2));

// Exit 0 on a completed round OR a typed fail-closed abort; the coordinator
// judges `ok`/`classification`, not the exit code.
process.exit(0);
