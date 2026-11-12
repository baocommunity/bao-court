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
 *
 * DISTRIBUTED MODE (`scripts/court/distributed-ceremony.mjs`): the same binary,
 * run on a different BOX per juror, against a standalone relay
 * (`scripts/court/relay-server.mjs`). Adds `--relay-url=`, `--token-file=`,
 * `--identity-file=`, `--roster-file=`, `--timings-file=`, `--identity-only`.
 * With none of those supplied, behaviour is byte-identical to the loopback
 * harness (same argv, same headers — no Authorization header at all).
 */

import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { finalizeEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { scalarToHex, seededScalar, deriveXOnlyPubkey, verifyFinalSignature } from '../../crypto';
import { IndependentDkgSession } from '../../independentDkg';
import { IndependentSigningSession } from '../../independentSigning';
import {
  parseDkgCommitmentEvent,
  parseFrostCommitEvent,
  parseFrostRevealEvent,
} from '../../eventsParse';
import { parseEncryptedShareEvent } from '../../dkgMessages';
import { UNBONDED, parseCourtBondRef } from '../../bondVerification';
import type { CourtBondRef } from '../../bondVerification';
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

function argOpt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/**
 * `--relay=` and `--relay-url=` are the same option. `--relay` is what the
 * loopback harness passes today; `--relay-url` is the name the distributed
 * driver uses. Keeping both means the loopback path is untouched — this juror
 * binary still behaves exactly as before when its caller says `--relay=`.
 */
const relayUrl = argOpt('relay') ?? argOpt('relay-url') ?? (() => {
  throw new Error('missing --relay (or --relay-url)');
})();
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
/** Per-request HTTP bound. A remote relay needs a real, generous timeout. */
const httpTimeoutMs = Number(arg('http-timeout-ms', '5000'));
/**
 * Honour a delay between "this juror has enough commitments" and "this juror
 * reveals". Default 0 = no delay, exactly the harness behaviour. The
 * distributed driver sets this for the kill scenario: the honest
 * commit→reveal gap is one poll (~20 ms), which is shorter than an out-of-band
 * SIGKILL can be delivered over ssh (~40-80 ms). Stretching the window lets
 * the kill land where it is supposed to — it does NOT change what is tested
 * (the receive-side reveal gate), it only makes the fault deliverable.
 */
const revealDelayMs = Number(arg('reveal-delay-ms', '0'));

/**
 * Distributed-ceremony options (absent ⇒ legacy loopback behaviour, unchanged):
 *   --token-file=    0600 file holding the relay's shared bearer token
 *   --identity-file= 0600 file holding THIS box's secret key (created if absent)
 *   --roster-file=   public roster [{idx, pubkey}] (no secrets)
 *   --timings-file=  JSONL of per-request wire timings (real RTT measurement)
 *   --identity-only  generate/load the identity, print `IDENTITY <pubkey>`, exit
 */
const tokenFile = argOpt('token-file');
const identityFile = argOpt('identity-file');
const rosterFile = argOpt('roster-file');
const timingsFile = argOpt('timings-file');
const identityOnly = process.argv.includes('--identity-only');

const encoder = new TextEncoder();

/**
 * Identity: derived deterministically from the ceremony seed so every
 * process computes the same roster without a trust handshake. A simulation
 * convenience — production rosters come from a signed selection event.
 *
 * DISTRIBUTED MODE (`--identity-file=`): the key is NOT derived from anything
 * the coordinator knows. Each box generates its own key the first time it is
 * asked (CSPRNG, 0600 file, never transmitted), and only its x-only PUBLIC key
 * travels (`--identity-only` prints `IDENTITY <pubkey>`). The roster then
 * arrives as public material in `--roster-file=`. Same session pipeline, same
 * wire format; the only change is where the secret comes from.
 */
function identityFor(idx: number): { seckey: Uint8Array; pubkey: string } {
  if (identityFile && idx === myIdx) return boxIdentity();
  const seckeyHex = scalarToHex(
    seededScalar(hexToBytes(seedHex), encoder.encode(`r30/juror/${idx}`)),
  );
  const seckey = hexToBytes(seckeyHex);
  return { seckey, pubkey: deriveXOnlyPubkey(seckeyHex) };
}

function boxIdentity(): { seckey: Uint8Array; pubkey: string } {
  const path = identityFile as string;
  let seckeyHex: string;
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { seckey?: string };
    if (!parsed.seckey || !/^[0-9a-f]{64}$/i.test(parsed.seckey)) {
      throw new Error(`--identity-file ${path} is not a { "seckey": <64 hex> } document`);
    }
    seckeyHex = parsed.seckey.toLowerCase();
  } else {
    // Generate from the platform CSPRNG and write 0600 BEFORE anything else on
    // this box can read it. The value is never printed and never logged.
    seckeyHex = bytesToHex(secp256k1.utils.randomSecretKey());
    writeFileSync(path, JSON.stringify({ seckey: seckeyHex }), { mode: 0o600 });
  }
  return { seckey: hexToBytes(seckeyHex), pubkey: deriveXOnlyPubkey(seckeyHex) };
}

/**
 * Public roster from `--roster-file=` (idx → x-only pubkey + bond reference).
 * The bond reference is CARRIED, not verified: verification is a separate,
 * per-rail step (`verifyBond`). This round plumbs the shape and records it.
 */
interface RosterEntry {
  readonly idx: number;
  readonly pubkey: string;
  readonly bond: CourtBondRef;
}

function rosterFileEntries(): RosterEntry[] | null {
  if (!rosterFile) return null;
  const parsed = JSON.parse(readFileSync(rosterFile, 'utf8')) as {
    idx: number;
    pubkey: string;
    bond?: unknown;
  }[];
  return parsed.map((entry) => ({
    idx: Number(entry.idx),
    pubkey: String(entry.pubkey),
    // A missing bond is the honest default (rail `none`); a MALFORMED one throws.
    bond: entry.bond === undefined ? UNBONDED : parseCourtBondRef(entry.bond),
  }));
}

const me = identityFor(myIdx);

if (identityOnly) {
  // The ONLY thing that crosses the wire here is a public key.
  process.stdout.write(`IDENTITY ${me.pubkey}\n`);
  process.exit(0);
}

const runDir = join(stateDir, `juror-${myIdx}`);
mkdirSync(runDir, { recursive: true });
const publishedLog = join(runDir, 'published.jsonl');

const rosterEntries = rosterFileEntries();
const rosterPubkeys = rosterEntries
  ? new Map(rosterEntries.map((entry) => [entry.idx, entry.pubkey]))
  : null;
/** This juror's OWN bond reference, echoed verbatim into the REPORT. */
const myBond: CourtBondRef = rosterEntries?.find((entry) => entry.idx === myIdx)?.bond ?? UNBONDED;
if (rosterPubkeys) {
  const mine = rosterPubkeys.get(myIdx);
  if (mine !== me.pubkey) {
    throw new Error(
      `roster/identity mismatch on this box: --identity-file pubkey ${me.pubkey} `
      + `!= roster[${myIdx}] ${String(mine)} (a box must not sign under a key it does not hold)`,
    );
  }
}

function roster(): SelectedJuror[] {
  return Array.from({ length: jurorCount }, (_, i) => {
    const idx = i + 1;
    const pubkey = rosterPubkeys?.get(idx) ?? (idx === myIdx ? me.pubkey : identityFor(idx).pubkey);
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
// Relay client (real HTTP: loopback in the harness, a real network here)
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
 * The relay's shared bearer token, read from a 0600 file. Absent file ⇒ no
 * Authorization header at all, which is exactly what the loopback harness's
 * inline relay expects — the default path stays byte-identical.
 */
const relayToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '';
if (relayToken && relayToken.length < 16) {
  throw new Error('--token-file must contain at least 16 characters');
}
const authHeaders: Record<string, string> = relayToken
  ? { authorization: `Bearer ${relayToken}` }
  : {};

/**
 * Per-request wire timings. This is how the REAL network is measured: the
 * client-side duration of each POST/GET is the round trip plus the relay's
 * handling time (the relay logs its own handling separately), and
 * `serverDeltaMs` = clientNow − relay's `serverTime` after the response has
 * arrived, i.e. the response leg plus any clock offset between the boxes.
 * Nothing here is modelled.
 */
interface WireTiming {
  readonly at: number;
  readonly op: 'publish' | 'poll';
  readonly ms: number;
  readonly status: number;
  readonly bytes: number;
  readonly serverDeltaMs: number | null;
}
const timings: WireTiming[] = [];
const timingsStart = Date.now();
function recordTiming(timing: WireTiming): void {
  if (!timingsFile) return;
  timings.push(timing);
  appendFileSync(timingsFile, JSON.stringify(timing) + '\n');
}

/**
 * `as=<idx>` is how the relay knows WHICH juror is polling. That is not a
 * concession to the simulation: a real relay sees a distinct connection per
 * subscriber and can serve each one a different view (eclipse / split-view).
 * Declaring it makes the per-juror view explicit and reproducible instead of
 * hidden in connection bookkeeping.
 */
async function publish(envelope: Envelope): Promise<number> {
  const body = JSON.stringify(envelope);
  const t0 = performance.now();
  const response = await fetch(`${relayUrl}/events?as=${myIdx}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body,
    signal: AbortSignal.timeout(httpTimeoutMs),
  });
  const ms = performance.now() - t0;
  if (!response.ok) {
    recordTiming({
      at: Date.now() - timingsStart, op: 'publish', ms, status: response.status, bytes: body.length, serverDeltaMs: null,
    });
    throw new Error(`relay publish failed: ${response.status}`);
  }
  const { seq, serverTime } = (await response.json()) as { seq: number; serverTime?: number };
  recordTiming({
    at: Date.now() - timingsStart,
    op: 'publish',
    ms,
    status: response.status,
    bytes: body.length,
    serverDeltaMs: typeof serverTime === 'number' ? Date.now() - serverTime : null,
  });
  appendFileSync(publishedLog, JSON.stringify({ seq, envelope }) + '\n');
  return seq;
}

async function poll(cursor: number): Promise<{ messages: (Envelope & { seq: number })[]; next: number }> {
  const t0 = performance.now();
  const response = await fetch(`${relayUrl}/events?since=${cursor}&as=${myIdx}`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(httpTimeoutMs),
  });
  const ms = performance.now() - t0;
  if (!response.ok) {
    recordTiming({
      at: Date.now() - timingsStart, op: 'poll', ms, status: response.status, bytes: 0, serverDeltaMs: null,
    });
    throw new Error(`relay poll failed: ${response.status}`);
  }
  const body = (await response.json()) as {
    messages: (Envelope & { seq: number })[];
    next: number;
    serverTime?: number;
  };
  recordTiming({
    at: Date.now() - timingsStart,
    op: 'poll',
    ms,
    status: response.status,
    bytes: body.messages.length,
    serverDeltaMs: typeof body.serverTime === 'number' ? Date.now() - body.serverTime : null,
  });
  return { messages: body.messages, next: body.next };
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
  /**
   * The lowest roster index this process **did not hear from** in the phase
   * that failed (F2 in docs/MULTI_PROCESS_CEREMONY.md).
   *
   * Diagnostic only. Under `silence` this names a censoring participant; under
   * `drop` / `reorder --reorder-style=invert` it names an **honest** sender
   * whose message the relay discarded. It is therefore NEVER slashing evidence:
   * slashing uses the signed evidence paths (DkgVerificationFailure,
   * falseComplaints), not this classification.
   */
  readonly blamedIdx?: number;
  readonly groupPubkeyXOnly?: string;
  /**
   * This juror's bond REFERENCE, echoed verbatim from the roster file. Carried
   * and recorded, never treated as verified: a later round replaces `none`
   * with a rail proof whose `verifyBond` must pass before the key counts.
   */
  readonly bond?: CourtBondRef;
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
  /**
   * Messages for a LATER phase that arrive while this juror is still in DKG.
   * A peer that finishes key generation first publishes its FROST commitment
   * immediately; phase-segregated polling used to advance the cursor past that
   * record and DISCARD it, which over a real network (25-40 ms RTT, a slower
   * box) makes honest peers look like they never committed. Buffer instead of
   * dropping: the signing loop ingests these before it polls anything new.
   */
  const deferred: (Envelope & { seq: number })[] = [];
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
      } else if (message.phase === 'frost-commit' || message.phase === 'frost-reveal') {
        deferred.push(message);
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
  /** Earliest wall-clock time this juror may reveal (see `--reveal-delay-ms`). */
  let revealNotBefore = 0;
  const signDeadline = Date.now() + signDeadlineMs;
  let attestation = null;

  /** One signing-phase record through the production gates. */
  const ingestSign = async (message: Envelope & { seq: number }): Promise<boolean> => {
    if (message.round !== round || message.from === myIdx || !message.event) return false;
    noteDelivery(message.event.id);
    if (message.phase === 'frost-commit') {
      const parsed = parseFrostCommitEvent(message.event);
      if (!parsed) return false;
      if (signing.addCommitment({
        idx: parsed.jurorIdx,
        pubkey: parsed.pubkey,
        commitmentPackage: parsed.commitmentPackage,
      })) {
        committed.add(parsed.jurorIdx);
        return true;
      }
      return false;
    }
    if (message.phase === 'frost-reveal') {
      const parsed = parseFrostRevealEvent(message.event);
      if (!parsed) return false;
      if (signing.addReveal({
        idx: parsed.jurorIdx,
        pubkey: parsed.frostPubkey,
        publicNonce: parsed.publicNonce,
        partialSig: parsed.partialSig,
      })) {
        revealed.add(parsed.jurorIdx);
        return true;
      }
      return false;
    }
    return false;
  };

  // Everything a faster peer published while we were still doing DKG.
  let deferredIngested = 0;
  for (const message of deferred) {
    noteDelivery(message.event?.id);
    if (await ingestSign(message)) deferredIngested += 1;
  }

  while (Date.now() < signDeadline) {
    const { messages, next } = await poll(cursor);
    cursor = next;
    let fresh = 0;
    for (const message of messages) {
      if (await ingestSign(message)) fresh += 1;
    }
    if (signing.hasEnoughCommitments() && !revealed.has(myIdx)) {
      if (revealNotBefore === 0) revealNotBefore = Date.now() + revealDelayMs;
      if (Date.now() >= revealNotBefore) {
        const { event: revealTemplate } = signing.createMyReveal(share);
        await send({
          round,
          phase: 'frost-reveal',
          from: myIdx,
          event: finalizeEvent(revealTemplate as EventTemplate, me.seckey),
        });
        revealed.add(myIdx);
      }
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
      bond: myBond,
      groupPubkeyXOnly: record.groupPubkeyXOnly,
      disclosure: {
        committed: [...committed].sort((a, b) => a - b),
        revealed: [...revealed].sort((a, b) => a - b),
        missingCommits: missingCommits.sort((a, b) => a - b),
        missingReveals: missingReveals.sort((a, b) => a - b),
        deferredIngested,
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
    bond: myBond,
    groupPubkeyXOnly: record.groupPubkeyXOnly,
    signature: attestation.signature,
    message: attestation.message,
    signatureVerifies: verifies,
    disclosure: {
      committed: [...committed].sort((a, b) => a - b),
      deferredIngested,
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
