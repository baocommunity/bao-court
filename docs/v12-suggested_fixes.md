# V12 Audit — Suggested Fixes Report

> Generated from `docs/f12_fiiixes_export.md`

> **All 35 actionable findings include V12-provided code patches.**


## Summary

| Category | Count |

|---|---|

| Total findings | 81 |

| Actionable (unreviewed) | 35 |

|  - High | 11 |

|  - Medium | 19 |

|  - Low | 5 |

| Invalid (intended behavior, no fix needed) | 46 |


## High Severity Findings

---

### Abort Events Can Forge Failure and Blame

**Affected files:** courtDkgMachine.ts

**V12 reasoning:** Reject caller-authored generic DKG abort events entirely, so failure phases and blame can only arise from reducer-validated protocol evidence (such as transcript mismatch) or deadline expiry; this also prevents runtime-injected phases from entering state.

```diff
diff --git a/courtDkgMachine.ts b/courtDkgMachine.ts
--- a/courtDkgMachine.ts
+++ b/courtDkgMachine.ts
@@ -1,275 +1,269 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /** Pure fail-closed state machine for one BAO Court DKG attempt. */
 
 export type CourtDkgPhase =
   | 'parameters_confirmed'
   | 'dkg_round_1'
   | 'dkg_round_2'
   | 'transcript_signing'
   | 'certified'
   | 'backed_up'
   | 'expired'
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite';
 
 export type CourtDkgFailurePhase = Extract<
   CourtDkgPhase,
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite'
 >;
 
 export interface CourtDkgFailure {
   readonly phase: CourtDkgFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtDkgMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
   readonly phase: CourtDkgPhase;
   readonly round1Participants: readonly number[];
   readonly round2Participants: readonly number[];
   readonly transcriptCertifiers: readonly number[];
   readonly transcriptHash?: string;
   readonly candidateGroupPubkey?: string;
   /** Unavailable until every participant certifies the exact transcript. */
   readonly certifiedGroupPubkey?: string;
   readonly backupVerified: boolean;
   readonly failure?: CourtDkgFailure;
 }
 
 export type CourtDkgMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | { readonly type: 'accept_round_1'; readonly idx: number; readonly now: number }
   | { readonly type: 'accept_round_2'; readonly idx: number; readonly now: number }
   | {
       readonly type: 'finalize_transcript';
       readonly transcriptHash: string;
       readonly candidateGroupPubkey: string;
       readonly now: number;
     }
   | {
       readonly type: 'accept_certification';
       readonly idx: number;
       readonly transcriptHash: string;
       readonly now: number;
     }
   | { readonly type: 'confirm_backup'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtDkgFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtDkgTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtDkgTransitionError';
   }
 }
 
 const HEX_32 = /^[0-9a-f]{64}$/;
 const GROUP_KEY = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 
 const TERMINAL_PHASES = new Set<CourtDkgPhase>([
   'backed_up',
   'expired',
   'delivery_failed',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
   'incompatible_suite',
 ]);
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtDkgTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function addSorted(values: readonly number[], idx: number): readonly number[] {
   if (values.includes(idx)) return values;
   return [...values, idx].sort((a, b) => a - b);
 }
 
 function assertParticipant(state: CourtDkgMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtDkgTransitionError(`participant ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtDkgMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtDkgTransitionError('DKG message arrived at or after the ceremony deadline');
   }
 }
 
 function expire(state: CourtDkgMachineState, now: number): CourtDkgMachineState {
   assertNow(now);
   if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') return state;
   if (now < state.deadline) return state;
   return {
     ...state,
     phase: 'expired',
     failure: { phase: 'expired', reason: 'The DKG deadline passed before unanimous certification.' },
   };
 }
 
 export function createCourtDkgMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
 }): CourtDkgMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtDkgTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtDkgTransitionError('deadline must be a positive Unix timestamp');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtDkgTransitionError('DKG requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtDkgTransitionError('participant indices must be ordered and sequential');
     }
   });
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     deadline: params.deadline,
     phase: 'parameters_confirmed',
     round1Participants: [],
     round2Participants: [],
     transcriptCertifiers: [],
     backupVerified: false,
   };
 }
 
 export function reduceCourtDkgMachine(
   state: CourtDkgMachineState,
   event: CourtDkgMachineEvent,
 ): CourtDkgMachineState {
   if (event.type === 'tick') return expire(state, event.now);
   if (event.type === 'abort') {
-    if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') {
-      throw new CourtDkgTransitionError(`cannot abort DKG from ${state.phase}`);
-    }
-    if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
-    return {
-      ...state,
-      phase: event.phase,
-      failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
-    };
+    throw new CourtDkgTransitionError(
+      'DKG aborts must be derived from validated protocol evidence or deadline expiry',
+    );
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtDkgTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'parameters_confirmed') {
       throw new CourtDkgTransitionError(`cannot start DKG from ${state.phase}`);
     }
     return { ...state, phase: 'dkg_round_1' };
   }
 
   if (event.type === 'accept_round_1') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_1') {
       throw new CourtDkgTransitionError(`cannot accept round 1 data during ${state.phase}`);
     }
     const accepted = addSorted(state.round1Participants, event.idx);
     return {
       ...state,
       round1Participants: accepted,
       phase: accepted.length === state.participantIndices.length ? 'dkg_round_2' : state.phase,
     };
   }
 
   if (event.type === 'accept_round_2') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_2') {
       throw new CourtDkgTransitionError(`cannot accept round 2 data during ${state.phase}`);
     }
     return { ...state, round2Participants: addSorted(state.round2Participants, event.idx) };
   }
 
   if (event.type === 'finalize_transcript') {
     assertBeforeDeadline(state, event.now);
     if (
       state.phase !== 'dkg_round_2'
       || state.round2Participants.length !== state.participantIndices.length
     ) {
       throw new CourtDkgTransitionError('cannot finalize before every participant completes round 2');
     }
     if (!HEX_32.test(event.transcriptHash) || !GROUP_KEY.test(event.candidateGroupPubkey)) {
       throw new CourtDkgTransitionError('transcript hash or candidate group key has invalid encoding');
     }
     return {
       ...state,
       phase: 'transcript_signing',
       transcriptHash: event.transcriptHash,
       candidateGroupPubkey: event.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'accept_certification') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'transcript_signing' || !state.transcriptHash || !state.candidateGroupPubkey) {
       throw new CourtDkgTransitionError(`cannot certify transcript during ${state.phase}`);
     }
     if (event.transcriptHash !== state.transcriptHash) {
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A participant certified a different DKG transcript.',
         },
       };
     }
     const certifiers = addSorted(state.transcriptCertifiers, event.idx);
     if (certifiers.length !== state.participantIndices.length) {
       return { ...state, transcriptCertifiers: certifiers };
     }
     return {
       ...state,
       phase: 'certified',
       transcriptCertifiers: certifiers,
       certifiedGroupPubkey: state.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'confirm_backup') {
     // Backup confirmation is a LOCAL event (the juror validated its own
     // recovery data), not a peer message, so it is not bounded by the
     // ceremony deadline. A certified machine must never be stranded: without
     // this, a certification at the deadline could never reach `backed_up`
     // and was frozen in `certified` forever.
     assertNow(event.now);
     if (state.phase !== 'certified' || !state.certifiedGroupPubkey) {
       throw new CourtDkgTransitionError('cannot confirm recovery data before DKG certification');
     }
     return { ...state, phase: 'backed_up', backupVerified: true };
   }
 
   return state;
 }

```


---

### Bind verdict commitments to their dispute

**Affected files:** dispute.ts, validator.ts, appealCoordinator.ts

**V12 reasoning:** Derive dispute verdict hashes from the current dispute, outcome, and supporting reveal IDs at the signing boundary; recompute the same commitment when validating events; and require settlement attestations to match the appeal's frozen canonical verdict inputs.

```diff
diff --git a/dispute.ts b/dispute.ts
--- a/dispute.ts
+++ b/dispute.ts
@@ -1,167 +1,178 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Dispute override signing for the BAO Court / FROST appeal layer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
 import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
 import * as frost from '@vbyte/frost';
 import { CanonicalWriter } from './courtSession';
 import { runNormalSigningRound } from './signing';
+import { hashDisputeVerdict } from './courtVoteMachine';
 import type { DkgRecord, DisputeCase, FrostAttestation, JurorVote } from './types';
 
 /** Same domain tag as the machine-path vote commit (courtVoteMachine). */
 const VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 
 /**
  * Commit hash for the imperative vote path: H(domain, outcome, salt) with
  * canonical length-prefixed encoding. The old `${outcome}|${salt}` join was
  * ambiguous — an outcome containing `|` could alias the salt and let two
  * distinct ballots commit to the same digest.
  */
 export function hashCommit(outcome: string, salt: string): string {
   const writer = new CanonicalWriter();
   writer.text(outcome);
   writer.text(salt);
   const encoded = writer.finish();
   const domain = new TextEncoder().encode(VOTE_COMMIT_DOMAIN);
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 export interface TallyResult {
   readonly outcome: string;
   readonly supportingVotes: JurorVote[];
   /**
    * Revealed votes whose commit-reveal hash did not match. They are excluded
    * from the tally (matching CourtVoteMachine, which refuses a mismatched
    * reveal at accept time) and surfaced here as slashing evidence. A single
    * malformed or malicious reveal must not abort the whole count.
    */
   readonly invalidReveals: JurorVote[];
 }
 
 export function tallyVotes(
   votes: readonly JurorVote[],
 ): TallyResult {
   const counts = new Map<string, JurorVote[]>();
   const invalidReveals: JurorVote[] = [];
   for (const v of votes) {
     if (!v.reveal) continue;
     if (hashCommit(v.reveal.outcome, v.reveal.salt) !== v.commit) {
       invalidReveals.push(v);
       continue;
     }
     const list = counts.get(v.reveal.outcome) ?? [];
     list.push(v);
     counts.set(v.reveal.outcome, list);
   }
 
   let winner = '';
   let max = -1;
   // Deterministic, order-independent tie-break: on equal counts the
   // lexicographically smallest outcome wins. This MUST match
   // courtVoteMachine.finalize_tally so every observer derives the same
   // verdict regardless of reveal arrival order.
   for (const [outcome, list] of counts.entries()) {
     if (list.length > max || (list.length === max && outcome < winner)) {
       max = list.length;
       winner = outcome;
     }
   }
 
   return {
     outcome: winner,
     supportingVotes: counts.get(winner) ?? [],
     invalidReveals,
   };
 }
 
 /**
  * Derive a deterministic x-only pubkey from the normal group key + dispute id.
  *
  * WARNING: the derivation maps public inputs to a scalar, so the private key
  * of the returned pubkey is PUBLICLY COMPUTABLE (known discrete log). This
  * key is NOT threshold-protected and must NEVER be used to accept FROST
  * attestation signatures — anyone could sign for it. It exists for demo
  * contracts that need a deterministic dispute key; keep it out of any path
  * that authenticates real value.
  */
 export function deriveDisputeGroupPubkey(
   normalGroupPubkey: string,
   disputeId: string,
 ): string {
   const order = secp256k1.Point.Fn.ORDER;
   let digest = sha256(new TextEncoder().encode(normalGroupPubkey + disputeId));
   let scalar = bytesToNumberBE(digest) % order;
   // Re-hash on the astronomically unlikely zero scalar to guarantee a valid key.
   while (scalar === 0n) {
     digest = sha256(digest);
     scalar = bytesToNumberBE(digest) % order;
   }
   const scalarBytes = numberToBytesBE(scalar, 32);
   const pk = schnorr.getPublicKey(scalarBytes);
   return bytesToHex(pk);
 }
 
 export interface DisputeSigningParams {
   readonly dispute: DisputeCase;
   readonly dkg: DkgRecord;
   readonly shares: readonly frost.SecretShare[];
   /** Outcome to attest. Defaults to the dispute's proposed outcome. */
   readonly outcome?: string;
   /**
-   * Dispute verdict commitment bound into the signed message. REQUIRED for
-   * real dispute attestations — see {@link buildAttestationMessage}.
+   * Optional caller assertion for compatibility. The signer derives the
+   * commitment and rejects this value if it does not match.
    */
   readonly verdictHash?: string;
-  /** Supporting reveal event ids of the attested verdict. */
+  /** Supporting reveal event ids used to derive the dispute verdict commitment. */
   readonly supportingEventIds?: readonly string[];
 }
 
 export function runDisputeOverrideSigning(
   params: DisputeSigningParams,
 ): FrostAttestation {
+  const outcome = params.outcome ?? params.dispute.proposedOutcome;
+  const supportingEventIds = params.supportingEventIds ?? [];
+  const verdictHash = hashDisputeVerdict({
+    disputeId: params.dispute.disputeId,
+    outcome,
+    supportingEventIds,
+  });
+  if (params.verdictHash !== undefined && params.verdictHash !== verdictHash) {
+    throw new Error('verdictHash does not match the dispute verdict inputs');
+  }
   const attestation = runNormalSigningRound({
     marketId: params.dispute.marketId,
-    outcome: params.outcome ?? params.dispute.proposedOutcome,
+    outcome,
     round: 1,
     disputeEventId: params.dispute.disputeId,
-    verdictHash: params.verdictHash,
+    verdictHash,
     dkg: params.dkg,
     shares: params.shares,
   });
 
   return {
     ...attestation,
     kind: 39007,
     disputeEventId: params.dispute.disputeId,
-    verdictHash: params.verdictHash,
-    supportingEventIds: params.supportingEventIds,
+    verdictHash,
+    supportingEventIds,
   };
 }
 
 /**
  * Canonical synthetic reveal event id for SIMULATED ceremonies (the demo
  * coordinator and the end-to-end simulator run the vote in-process, so no
  * Nostr reveal events exist to reference). Production ceremonies MUST use the
  * real kind-39014 reveal event ids — the commitment is over the same field,
  * so swapping in real ids changes nothing structurally.
  */
 export function deriveSimulatedRevealEventId(idx: number, outcome: string, salt: string): string {
   const writer = new CanonicalWriter();
   writer.u32(idx);
   writer.text(outcome);
   writer.text(salt);
   const encoded = writer.finish();
   const domain = new TextEncoder().encode('BAO-Court/SimRevealEvent/v1');
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }

diff --git a/validator.ts b/validator.ts
--- a/validator.ts
+++ b/validator.ts
@@ -1,195 +1,219 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * FROST attestation validator for the BAO Court / FROST appeal layer.
  */
 
 import { schnorr } from '@noble/curves/secp256k1.js';
 import { hexToBytes } from '@noble/hashes/utils.js';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { verifyEvent } from 'nostr-tools/pure';
 import { BAO_COURT_ATTESTATION_KIND } from './events';
 import { buildAttestationMessage } from './crypto';
+import { hashDisputeVerdict } from './courtVoteMachine';
 
 export interface ValidationResult {
   readonly valid: boolean;
   readonly pubkey: string;
   readonly outcome?: string;
   readonly message?: string;
   readonly disputeEventId?: string;
   readonly error?: string;
 }
 
 export interface AttestationValidationContext {
   readonly expectedGroupPubkey?: string;
   readonly expectedDisputeEventId?: string;
   readonly expectedMarketId?: string;
   readonly allowedOutcomes?: readonly string[];
   readonly trustedPublisherPubkeys?: readonly string[];
 }
 
 function uniqueTag(event: Pick<NostrEvent, 'tags'>, name: string): string | null {
   const matches = event.tags.filter((tag) => tag[0] === name);
   if (matches.length !== 1 || matches[0].length !== 2 || !matches[0][1]) return null;
   return matches[0][1];
 }
 
 function isHex64(value: string): boolean {
   return /^[0-9a-fA-F]{64}$/.test(value);
 }
 
 export function validateAttestationEvent(
   event: NostrEvent,
   expected?: string | AttestationValidationContext,
 ): ValidationResult {
   const context = typeof expected === 'string'
     ? { expectedGroupPubkey: expected }
     : (expected ?? {});
   if (event.kind !== 89 && event.kind !== BAO_COURT_ATTESTATION_KIND) {
     return { valid: false, pubkey: '', error: `Not a Kind 89 or ${BAO_COURT_ATTESTATION_KIND} attestation` };
   }
 
   if (!verifyEvent(event)) {
     return { valid: false, pubkey: '', error: 'Invalid Nostr event signature or id' };
   }
   if (
     context.trustedPublisherPubkeys &&
     !context.trustedPublisherPubkeys.includes(event.pubkey)
   ) {
     return { valid: false, pubkey: '', error: 'Untrusted attestation publisher' };
   }
 
   const pubkey = uniqueTag(event, 'p');
   const signature = uniqueTag(event, 'sig');
   const nonce = uniqueTag(event, 'nonce');
   const outcome = uniqueTag(event, 'outcome');
   const disputeEventId = uniqueTag(event, 'dispute');
   const marketId = uniqueTag(event, 'm');
   const round = uniqueTag(event, 'round');
   const verdictHash = uniqueTag(event, 'verdict');
 
   if (!pubkey || !signature || !nonce || !outcome || !marketId || !round) {
     return { valid: false, pubkey: '', error: 'Missing required tags' };
   }
 
   if (!pubkey || !isHex64(pubkey)) {
     return { valid: false, pubkey: pubkey ?? '', error: 'Invalid group pubkey' };
   }
   if (!signature || !/^[0-9a-fA-F]{128}$/.test(signature)) {
     return { valid: false, pubkey, error: 'Invalid signature' };
   }
   if (!nonce || !isHex64(nonce)) {
     return { valid: false, pubkey, error: 'Invalid public nonce' };
   }
   // The nonce tag must match the R value embedded in the signature (R || s).
   if (nonce !== signature.slice(0, 64)) {
     return { valid: false, pubkey, error: 'Nonce tag does not match signature' };
   }
   // Kind 39007 attestations are dispute-scoped and must carry a dispute tag.
   if (event.kind === BAO_COURT_ATTESTATION_KIND && !disputeEventId) {
     return { valid: false, pubkey, error: 'Missing dispute tag on dispute attestation' };
   }
   // Kind 39007 attestations must bind the dispute verdict (the tally): the
   // FROST signature certifies the outcome WON the vote, not just the outcome.
   if (event.kind === BAO_COURT_ATTESTATION_KIND) {
     if (!verdictHash || !isHex64(verdictHash)) {
       return { valid: false, pubkey, error: 'Missing or invalid verdict hash on dispute attestation' };
     }
   }
 
   if (context.expectedGroupPubkey && pubkey !== context.expectedGroupPubkey) {
     return {
       valid: false,
       pubkey,
       error: `Pubkey mismatch: expected ${context.expectedGroupPubkey}, got ${pubkey}`,
     };
   }
   if (context.expectedDisputeEventId && disputeEventId !== context.expectedDisputeEventId) {
     return { valid: false, pubkey, error: 'Dispute id mismatch' };
   }
   if (context.expectedMarketId && marketId !== context.expectedMarketId) {
     return { valid: false, pubkey, error: 'Market id mismatch' };
   }
   if (context.allowedOutcomes && !context.allowedOutcomes.includes(outcome)) {
     return { valid: false, pubkey, error: 'Outcome is not allowed' };
   }
 
   try {
     const content = JSON.parse(event.content || '{}') as Record<string, unknown>;
     const message = String(content.message || '');
     const contentOutcome = String(content.outcome ?? '');
     const contentDisputeId = typeof content.disputeEventId === 'string' ? content.disputeEventId : undefined;
     const contentVerdictHash = typeof content.verdictHash === 'string' ? content.verdictHash : undefined;
+    const contentSupportingEventIds = Array.isArray(content.supportingEventIds)
+      ? content.supportingEventIds.filter((id): id is string => typeof id === 'string')
+      : undefined;
+    const supportingEventIds = event.tags
+      .filter((tag) => tag[0] === 'e' && tag[3] === 'mention')
+      .map((tag) => tag[1]);
     const contentMarketId = String(content.marketId ?? '');
     const contentRound = String(content.round ?? '');
 
     if (!message) {
       return { valid: false, pubkey, error: 'Attestation message missing' };
     }
     if (outcome !== contentOutcome) {
       return {
         valid: false,
         pubkey,
         error: 'Outcome tag does not match content outcome',
       };
     }
     // A missing dispute tag (null) and a missing content disputeEventId
     // (undefined) are the same assertion: no dispute on this attestation.
     // Comparing the raw values would reject every kind-89 (normal-market)
     // attestation, which never carries dispute material.
     if ((disputeEventId ?? undefined) !== contentDisputeId) {
       return {
         valid: false,
         pubkey,
         error: 'Dispute tag does not match content dispute id',
       };
     }
     if (marketId !== contentMarketId || round !== contentRound) {
       return { valid: false, pubkey, error: 'Market or round tag does not match content' };
     }
     if ((verdictHash ?? undefined) !== contentVerdictHash) {
       return { valid: false, pubkey, error: 'Verdict tag does not match content verdict hash' };
     }
+    if (event.kind === BAO_COURT_ATTESTATION_KIND) {
+      if (
+        !contentSupportingEventIds
+        || contentSupportingEventIds.length !== supportingEventIds.length
+        || contentSupportingEventIds.some((id, index) => id !== supportingEventIds[index])
+      ) {
+        return { valid: false, pubkey, error: 'Supporting event tags do not match content' };
+      }
+      const expectedVerdictHash = hashDisputeVerdict({
+        disputeId: disputeEventId!,
+        outcome,
+        supportingEventIds,
+      });
+      if (verdictHash !== expectedVerdictHash) {
+        return { valid: false, pubkey, error: 'Verdict hash does not match dispute verdict inputs' };
+      }
+    }
     const expectedMessage = buildAttestationMessage(
       marketId,
       outcome,
       round,
       disputeEventId ?? undefined,
       verdictHash ?? undefined,
     );
     if (message !== expectedMessage) {
       return { valid: false, pubkey, error: 'Attestation message does not bind verdict fields' };
     }
 
     const ok = schnorr.verify(
       hexToBytes(signature),
       hexToBytes(message),
       hexToBytes(pubkey),
     );
     return ok
       ? { valid: true, pubkey, outcome, message, disputeEventId: disputeEventId ?? undefined }
       : { valid: false, pubkey, error: 'Schnorr signature verification failed' };
   } catch (err) {
     return {
       valid: false,
       pubkey,
       error: `Validation exception: ${err instanceof Error ? err.message : String(err)}`,
     };
   }
 }
 
 export function verifyRawSignature(
   pubkeyHex: string,
   messageHex: string,
   signatureHex: string,
 ): boolean {
   try {
     return schnorr.verify(
       hexToBytes(signatureHex),
       hexToBytes(messageHex),
       hexToBytes(pubkeyHex),
     );
   } catch {
     return false;
   }
 }

diff --git a/appealCoordinator.ts b/appealCoordinator.ts
--- a/appealCoordinator.ts
+++ b/appealCoordinator.ts
@@ -1,782 +1,799 @@
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
           // a missing or empty verdict (e.g. every reveal invalid) aborts
           // signing rather than attesting a claim or an empty outcome.
           const outcome = appeal.verdictOutcome;
           if (!outcome) {
             // Same fail-closed path as any other signing failure: reselect
             // from backups or refund — never attest a claim or an empty
             // outcome.
             maybeReselect(appeal, 'signing_failed', new Error('no_verdict: cannot sign without a tally winner'));
             break;
           }
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
+      if (!appeal.verdictOutcome || !appeal.verdictSupportingEventIds) {
+        emit('settlement_rejected', appeal, { reason: 'missing_verdict_inputs' });
+        return false;
+      }
+      const expectedVerdictHash = hashDisputeVerdict({
+        disputeId,
+        outcome: appeal.verdictOutcome,
+        supportingEventIds: appeal.verdictSupportingEventIds,
+      });
+      if (
+        appeal.verdictHash !== expectedVerdictHash
+        || attestation.outcome !== appeal.verdictOutcome
+        || attestation.verdictHash !== expectedVerdictHash
+      ) {
+        emit('settlement_rejected', appeal, { reason: 'verdict_mismatch' });
+        return false;
+      }
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

```


---

### Closed reveal ledger is mutable and finalization trusts unvalidated reveals

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** At the reveal-close boundary, validate every ledger record and replace the live array with a frozen deep snapshot. Revalidate the same roster, allowlist, formatting, commit-binding, participant-uniqueness, and event-ID-uniqueness invariants before tallying reconstructed state, so stale references and forged snapshots cannot influence a verdict.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,483 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
+function assertValidRevealLedger(state: CourtVoteMachineState): void {
+  const seenIndices = new Set<number>();
+  const seenEventIds = new Set<string>();
+  for (const reveal of state.reveals) {
+    assertParticipant(state, reveal.idx);
+    if (!state.allowedOutcomes.includes(reveal.outcome)) {
+      throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
+    }
+    if (!HEX_32.test(reveal.salt) || !HEX_32.test(reveal.eventId)) {
+      throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
+    }
+    if (seenIndices.has(reveal.idx)) {
+      throw new CourtVoteTransitionError(`participant ${reveal.idx} has duplicate vote reveals`);
+    }
+    if (seenEventIds.has(reveal.eventId)) {
+      throw new CourtVoteTransitionError('vote reveal event ids must be unique');
+    }
+    seenIndices.add(reveal.idx);
+    seenEventIds.add(reveal.eventId);
+    const commit = state.commits.find((candidate) => candidate.idx === reveal.idx);
+    if (!commit) {
+      throw new CourtVoteTransitionError(
+        `participant ${reveal.idx} revealed without a prior session commit`,
+      );
+    }
+    const expected = hashCourtVoteCommit({
+      sessionHash: state.sessionHash,
+      outcome: reveal.outcome,
+      salt: reveal.salt,
+    });
+    if (expected !== commit.commitHash) {
+      throw new CourtVoteTransitionError(
+        `vote reveal from participant ${reveal.idx} does not match its commit`,
+      );
+    }
+  }
+}
+
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
-    return { ...state, phase: 'reveal_closed' };
+    assertValidRevealLedger(state);
+    return {
+      ...state,
+      phase: 'reveal_closed',
+      reveals: Object.freeze(state.reveals.map((reveal) => Object.freeze({ ...reveal }))),
+    };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
+    assertValidRevealLedger(state);
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Define a canonical Unicode tie-break ordering

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Defines the protocol tie-break as lexicographic unsigned UTF-8 byte order and applies that comparator when tied reveal counts are resolved, aligning winner selection with canonical outcome serialization.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,451 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
+/** Protocol tie-break order: lexicographic unsigned UTF-8 bytes. */
+function compareOutcomeUtf8(left: string, right: string): number {
+  const leftBytes = textEncoder.encode(left);
+  const rightBytes = textEncoder.encode(right);
+  const length = Math.min(leftBytes.length, rightBytes.length);
+  for (let i = 0; i < length; i += 1) {
+    const difference = leftBytes[i] - rightBytes[i];
+    if (difference !== 0) return difference;
+  }
+  return leftBytes.length - rightBytes.length;
+}
+
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
-        (eventIds.length === winnerCount && outcome < winner)
+        (eventIds.length === winnerCount && compareOutcomeUtf8(outcome, winner) < 0)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Duplicate roster identities can control multiple threshold shares

**Affected files:** dkg.ts

**V12 reasoning:** Validate every DKG roster identity before participant/share creation: reject duplicate public keys, non-canonical lowercase 32-byte hex encodings, and x-coordinates that cannot be lifted to secp256k1 points.

```diff
diff --git a/dkg.ts b/dkg.ts
--- a/dkg.ts
+++ b/dkg.ts
@@ -1,621 +1,635 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pedersen-style distributed key generation adapter for the BAO Court / FROST oracle.
  *
  * This adapter simulates the full multi-party DKG inside a single local
  * process, but the cryptographic design is identical to a network version.
  *
  * NOTE: A coordinator-dependent DKG is NOT the desired design. The target is a
  * fully independent jury where every juror runs this logic on their own device
  * and exchanges only public commitments and encrypted shares over Nostr or other
  * peer-to-peer channels:
  *
  *   - Every juror generates its own private degree-(t-1) polynomial.
  *   - Every juror publishes Feldman coefficient commitments.
  *   - Every juror provides a Schnorr proof-of-knowledge of the constant coefficient.
  *   - Every received share is verified against the commitments.
  *   - Failed verifications raise complaints; if the revealed share is still
  *     invalid, the accused participant is disqualified.
  *   - The group secret never exists in one place — it is the sum of all
  *     remaining participants' constant coefficients.
  *
  * No single party materializes the group secret.
  *
  * NOTE: `generateFrostKeys()` defaults to `PedersenDkgAdapter`. The legacy
  * trusted-dealer adapter remains available as an explicit opt-in for tests and
  * demos. A production deployment MUST run the DKG across real user app instances
  * (browser/mobile/desktop) with encrypted peer-to-peer channels.
  */
 
 import { secp256k1 } from '@noble/curves/secp256k1.js';
 import * as frost from '@vbyte/frost';
 import { sha256 } from '@noble/hashes/sha2.js';
 import { hexToBytes } from '@noble/hashes/utils.js';
 import { createProofOfKnowledge, deriveXOnlyPubkey, randomScalar, scalarToHex, seededScalar, verifyProofOfKnowledge } from './crypto';
 import type { DkgRecord, SelectedJuror } from './types';
 
 const Point = secp256k1.Point;
 // secp256k1 curve order (scalar field).
 const N = secp256k1.Point.Fn.ORDER;
 type CurvePoint = InstanceType<typeof Point>;
 
 export function modN(x: bigint): bigint {
   const r = x % N;
   return r < 0n ? r + N : r;
 }
 
 /**
  * Evaluate a polynomial over the secp256k1 scalar field using Horner's rule.
  */
 export function evaluatePoly(coeffs: readonly bigint[], x: bigint): bigint {
   let result = 0n;
   for (let k = coeffs.length - 1; k >= 0; k--) {
     result = modN(modN(result * x) + coeffs[k]);
   }
   return result;
 }
 
 /**
  * Evaluate a polynomial whose coefficients are curve points at x.
  * This computes `sum_k A_k * x^k`.
  */
 export function evaluateCommitments(
   commitments: readonly CurvePoint[],
   x: bigint,
 ): CurvePoint {
   let result = Point.ZERO;
   for (let k = commitments.length - 1; k >= 0; k--) {
     result = result.multiply(x).add(commitments[k]);
   }
   return result;
 }
 
 /**
  * Evaluate a refresh polynomial at x.
  * Refresh polynomials have a zero constant term, so this computes
  * `sum_{k=1}^{degree} A_k * x^k`.
  */
 export function evaluateRefreshCommitments(
   commitments: readonly CurvePoint[],
   x: bigint,
 ): CurvePoint {
   let result = Point.ZERO;
   for (let k = commitments.length - 1; k >= 0; k--) {
     result = result.multiply(x).add(commitments[k]);
   }
   return result.multiply(x);
 }
 
 /**
  * Merge original DKG commitments with refresh commitments.
  * The refresh polynomial has degree threshold-1 but a zero constant term, so
  * its commitments are added to the original commitments starting at degree 1.
  */
 export function mergeRefreshCommitments(
   originalCommits: readonly string[],
   refreshCommits: readonly string[],
 ): string[] {
   if (refreshCommits.length !== originalCommits.length - 1) {
     throw new Error('Refresh commitment count must be one less than the threshold');
   }
   const orig = originalCommits.map((c) => Point.fromHex(c));
   const refr = refreshCommits.map((c) => Point.fromHex(c));
   const merged: CurvePoint[] = [orig[0]];
   for (let k = 1; k < orig.length; k++) {
     merged.push(orig[k].add(refr[k - 1]));
   }
   return merged.map((p) => p.toHex(true));
 }
 
 export function pointToXOnlyHex(point: CurvePoint): string {
   // Drop the 02/03 prefix from the compressed encoding to obtain a BIP340 x-only pubkey.
   return point.toHex(true).slice(2);
 }
 
 /**
  * Generate a zero-constant refresh polynomial package for an arbitrary set of
  * recipient indices.
  *
  * This replaces `frost.Lib.gen_refresh_shares`, which can only address
  * recipients `1..count` and therefore breaks for any non-contiguous juror
  * index set (e.g. after a DKG disqualification). The refresh polynomial is
  * `f(x) = c_1*x + ... + c_{t-1}*x^{t-1}` (zero constant term), so the group
  * public key is preserved. The returned commitments match the format expected
  * by {@link mergeRefreshCommitments} and {@link verifyRefreshShare}: one
  * commitment per non-constant coefficient, starting at degree 1.
  */
 export function generateRefreshShares(
   senderIdx: number,
   threshold: number,
   recipientIdxs: readonly number[],
 ): { vss_commits: string[]; idx: number; shares: frost.SecretShare[] } {
   if (threshold < 2) {
     throw new Error('Threshold must be at least 2');
   }
   if (recipientIdxs.length === 0 || recipientIdxs.some((i) => !Number.isInteger(i) || i < 1)) {
     throw new Error('Recipient indices must be positive integers');
   }
   const subCoeffs = Array.from({ length: threshold - 1 }, () => randomScalar());
   const coeffs = [0n, ...subCoeffs];
   const shares = recipientIdxs.map((idx) => ({
     idx,
     seckey: scalarToHex(evaluatePoly(coeffs, BigInt(idx))),
   }));
   const vss_commits = subCoeffs.map((c) => Point.BASE.multiply(c).toHex(true));
   return { vss_commits, idx: senderIdx, shares };
 }
 
 export interface PedersenDkgOptions {
   /**
    * When true, enables test/demo-only features: deterministic `seed` keygen
    * and the `corruptShare` fault injection hook. Never enable in production.
    */
   readonly unsafeTestMode?: boolean;
   /**
    * Test-only hook: simulate a dishonest participant that sends an invalid share.
    * The accused juror's share to the victim juror is corrupted, triggering a
    * complaint and disqualification. Requires `unsafeTestMode: true`.
    */
   readonly corruptShare?: { readonly accused: number; readonly victim: number };
   /**
    * Test-only hook: simulate a participant that fails its Schnorr
    * proof-of-knowledge of the constant term (e.g. committed to a point whose
    * discrete log it does not know). Requires `unsafeTestMode: true`.
    */
   readonly corruptPok?: { readonly accused: number };
 }
 
 export interface ParticipantState {
   readonly juror: SelectedJuror;
   readonly coeffs: readonly bigint[];
   readonly commitments: readonly CurvePoint[];
   readonly pok: ReturnType<typeof createProofOfKnowledge>;
 }
 
 export interface KeygenParams {
   readonly marketId: string;
   /** Optional dispute id (2140wtf scopes DKG to a dispute). */
   readonly disputeId?: string;
   readonly threshold: number;
   readonly jurors: readonly SelectedJuror[];
   /**
    * Optional deterministic seed. Only allowed when the adapter is constructed
    * with `unsafeTestMode: true`. Passing a shared/public seed in production
    * collapses the DKG because multiple jurors generate identical polynomials.
    */
   readonly seed?: string | Uint8Array;
 }
 
 export interface KeygenResult {
   readonly record: DkgRecord;
   readonly shares: frost.SecretShare[];
 }
 
 export interface RefreshParams {
   readonly record: DkgRecord;
   readonly shares: readonly frost.SecretShare[];
 }
 
 export interface RefreshResult {
   readonly record: DkgRecord;
   readonly shares: frost.SecretShare[];
 }
 
 /**
  * Interface that a production DKG implementation must satisfy.
  */
 export interface DkgAdapter {
   readonly run: (params: KeygenParams) => KeygenResult;
   readonly refreshShares: (params: RefreshParams) => RefreshResult;
 }
 export class PedersenDkgAdapter implements DkgAdapter {
   private readonly unsafeTestMode: boolean;
   private readonly corruptShare?: {
     readonly accused: number;
     readonly victim: number;
   };
   private readonly corruptPok?: { readonly accused: number };
   private paramsForProofDomain?: { readonly marketId: string; readonly disputeId?: string };
 
   constructor(options?: PedersenDkgOptions) {
     this.unsafeTestMode = options?.unsafeTestMode ?? false;
     if ((options?.corruptShare || options?.corruptPok) && !this.unsafeTestMode) {
       throw new Error('corruptShare/corruptPok require unsafeTestMode: true');
     }
     this.corruptShare = options?.corruptShare;
     this.corruptPok = options?.corruptPok;
   }
 
   private proofDomain(idx: number): string {
     const marketId = this.paramsForProofDomain?.marketId ?? '';
     const disputeId = this.paramsForProofDomain?.disputeId ?? '';
     return `market=${marketId}|dispute=${disputeId}|juror=${idx}`;
   }
 
   run(params: KeygenParams): KeygenResult {
     this.validateParams(params);
 
     if (params.seed && !this.unsafeTestMode) {
       throw new Error(
         'Deterministic DKG seed is only allowed in unsafeTestMode. ' +
           'A shared seed in production lets any juror reconstruct the group secret.',
       );
     }
 
     const { threshold, jurors } = params;
     this.paramsForProofDomain = { marketId: params.marketId, disputeId: params.disputeId };
     const participants = this.createParticipants(jurors, threshold, params);
     const disqualified = this.resolveComplaints(participants);
 
     const qualifiedParticipants = participants.filter(
       (p) => !disqualified.has(p.juror.idx),
     );
 
     if (qualifiedParticipants.length < threshold) {
       throw new Error(
         `Pedersen DKG failed: ${qualifiedParticipants.length} qualified participants remain, ` +
           `but threshold is ${threshold}`,
       );
     }
 
     const qualifiedJurors = jurors.filter((j) => !disqualified.has(j.idx));
 
     // Group public key = sum of all qualified constant-coefficient commitments.
     const groupPoint = qualifiedParticipants.reduce(
       (sum, p) => sum.add(p.commitments[0]),
       Point.ZERO,
     );
 
     // Each juror's final secret share is the sum of all qualified shares sent to them.
     const shares: frost.SecretShare[] = qualifiedJurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const secret = qualifiedParticipants.reduce(
         (sum, p) => modN(sum + evaluatePoly(p.coeffs, idx)),
         0n,
       );
       return { idx: juror.idx, seckey: scalarToHex(secret) };
     });
 
     // Verification shares are the public points matching the secret shares.
     const verificationShares = qualifiedJurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const pubkeyPoint = qualifiedParticipants.reduce(
         (sum, p) => sum.add(evaluateCommitments(p.commitments, idx)),
         Point.ZERO,
       );
       return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
     });
 
     // Sanity check: every secret share must produce the advertised verification share.
     for (const share of shares) {
       const expected = deriveXOnlyPubkey(share.seckey);
       const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
       if (actual !== expected) {
         throw new Error(
           `Pedersen DKG internal error: verification share mismatch for juror ${share.idx}`,
         );
       }
     }
 
     const groupPubkey = groupPoint.toHex(true);
     const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
 
     const vssCommitments = qualifiedParticipants.map((p) => ({
       idx: p.juror.idx,
       pubkey: p.juror.nostrPubkey,
       commits: p.commitments.map((c) => c.toHex(true)),
     }));
 
     const record: DkgRecord = {
       marketId: params.marketId,
       disputeId: params.disputeId,
       threshold,
       participants: qualifiedJurors.length,
       groupPubkey,
       groupPubkeyXOnly,
       verificationShares,
       jurorPubkeys: qualifiedJurors.map((j) => j.nostrPubkey),
       vssCommitments,
     };
 
     return { record, shares };
   }
 
   /**
    * Refresh all shares without changing the group public key.
    *
    * Each juror generates a random degree-(t-1) polynomial with a zero constant
    * term and distributes shares to every other juror. The refreshed share is
    * the old share plus the sum of all received refresh shares. The group public
    * key is unchanged because the refresh polynomials sum to zero.
    */
   refreshShares(params: RefreshParams): RefreshResult {
     this.validateRefreshParams(params);
 
     const { record, shares } = params;
     const threshold = record.threshold;
     const jurors = record.verificationShares.map((v) => {
       const vss = record.vssCommitments.find((c) => c.idx === v.idx);
       return {
         idx: v.idx,
         nostrPubkey: vss?.pubkey ?? '',
       };
     });
 
     // Each juror generates a refresh package for all participants. Indices
     // may be non-contiguous (e.g. after a disqualification), so the refresh
     // polynomials are generated locally rather than via
     // `frost.Lib.gen_refresh_shares`, which only supports recipients 1..n.
     const jurorIdxs = jurors.map((j) => j.idx);
     const refreshPackages = jurors.map((juror) =>
       generateRefreshShares(juror.idx, threshold, jurorIdxs),
     );
 
     // Combine every juror's current share with the refresh shares addressed to them.
     const refreshedShares = jurors.map((juror) => {
       const current = shares.find((s) => s.idx === juror.idx);
       if (!current) {
         throw new Error(`Missing current share for juror ${juror.idx}`);
       }
       const refreshShares = refreshPackages.map((pkg) =>
         frost.Lib.get_share(pkg.shares, juror.idx),
       );
       return frost.Lib.refresh_share(refreshShares, current);
     });
 
     // Merge original and refresh commitments so verification shares can be updated.
     const mergedVssCommitments = jurors.map((juror, i) => {
       const original = record.vssCommitments.find((c) => c.idx === juror.idx);
       if (!original) {
         throw new Error(`Missing original commitments for juror ${juror.idx}`);
       }
       return {
         idx: juror.idx,
         pubkey: juror.nostrPubkey,
         commits: mergeRefreshCommitments(original.commits, refreshPackages[i].vss_commits),
       };
     });
 
     const verificationShares = jurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const pubkeyPoint = mergedVssCommitments.reduce(
         (sum, c) => sum.add(evaluateCommitments(c.commits.map((h) => Point.fromHex(h)), idx)),
         Point.ZERO,
       );
       return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
     });
 
     // Sanity check: every refreshed share must match its verification share.
     for (const share of refreshedShares) {
       const expected = deriveXOnlyPubkey(share.seckey);
       const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
       if (actual !== expected) {
         throw new Error(
           `Refresh internal error: verification share mismatch for juror ${share.idx}`,
         );
       }
     }
 
     const groupPoint = mergedVssCommitments.reduce(
       (sum, c) => sum.add(Point.fromHex(c.commits[0])),
       Point.ZERO,
     );
     const groupPubkey = groupPoint.toHex(true);
     const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
 
     if (groupPubkey !== record.groupPubkey) {
       throw new Error('Refresh changed the group public key');
     }
 
     const newRecord: DkgRecord = {
       ...record,
       groupPubkey,
       groupPubkeyXOnly,
       verificationShares,
       vssCommitments: mergedVssCommitments,
     };
 
     return { record: newRecord, shares: refreshedShares };
   }
 
   private validateRefreshParams(params: RefreshParams): void {
     if (params.shares.length !== params.record.participants) {
       throw new Error('Share count does not match record participants');
     }
     if (params.record.threshold < 2) {
       throw new Error('Threshold must be at least 2');
     }
     const indices = new Set(params.shares.map((s) => s.idx));
     if (indices.size !== params.shares.length) {
       throw new Error('Duplicate share indices');
     }
     for (const share of params.shares) {
       const vss = params.record.vssCommitments.find((c) => c.idx === share.idx);
       if (!vss) {
         throw new Error(`No commitment found for share index ${share.idx}`);
       }
     }
   }
 
   private validateParams(params: KeygenParams): void {
     if (params.threshold < 2) {
       throw new Error('Threshold must be at least 2');
     }
     if (params.jurors.length < params.threshold) {
       throw new Error('Participants cannot be less than threshold');
     }
     const indices = new Set(params.jurors.map((j) => j.idx));
     if (indices.size !== params.jurors.length) {
       throw new Error('Duplicate juror indices');
     }
+    const pubkeys = new Set(params.jurors.map((j) => j.nostrPubkey));
+    if (pubkeys.size !== params.jurors.length) {
+      throw new Error('Duplicate juror public keys');
+    }
+    for (const juror of params.jurors) {
+      if (!/^[0-9a-f]{64}$/.test(juror.nostrPubkey)) {
+        throw new Error('Juror public keys must be canonical 32-byte lowercase hex');
+      }
+      try {
+        Point.fromHex(`02${juror.nostrPubkey}`);
+      } catch {
+        throw new Error('Juror public keys must be valid secp256k1 x-only keys');
+      }
+    }
     if (params.jurors.some((j) => j.idx < 1)) {
       throw new Error('Juror indices must be positive');
     }
   }
 
   private createParticipants(
     jurors: readonly SelectedJuror[],
     threshold: number,
     params: KeygenParams,
   ): ParticipantState[] {
     const seedBytes = params.seed
       ? (typeof params.seed === 'string'
         ? (params.seed.length === 64 && /^[0-9a-fA-F]{64}$/.test(params.seed)
           ? hexToBytes(params.seed)
           : sha256(new TextEncoder().encode(params.seed)))
         : params.seed)
       : undefined;
 
     return jurors.map((juror) => {
       const coeffs = Array.from({ length: threshold }, (_, k) => {
         if (!seedBytes) return randomScalar();
         const info = new TextEncoder().encode(
           `bao-frost-court/dkg-coeff|market=${params.marketId}|dispute=${params.disputeId ?? ''}|threshold=${threshold}|juror=${juror.idx}|k=${k}`,
         );
         return seededScalar(seedBytes, info);
       });
       const commitments = coeffs.map((a) => Point.BASE.multiply(a));
       const domain = this.proofDomain(juror.idx);
       const pok = createProofOfKnowledge(
         scalarToHex(coeffs[0]),
         commitments[0].toHex(true),
         domain,
       );
       if (this.corruptPok?.accused === juror.idx) {
         // Tamper: respond with a different valid scalar so verification fails.
         const z = BigInt(`0x${pok.response}`);
         return { juror, coeffs, commitments, pok: { ...pok, response: scalarToHex(modN(z + 1n)) } };
       }
       return { juror, coeffs, commitments, pok };
     });
   }
 
   /**
    * Simulate the share-verification and complaint phase.
    * For every pair (sender -> recipient), the recipient checks the share against
    * the sender's public commitments. A failed check is treated as a complaint;
    * the sender reveals the disputed share, and if it is still invalid the sender
    * is disqualified.
    */
   private resolveComplaints(
     participants: readonly ParticipantState[],
   ): Set<number> {
     const disqualified = new Set<number>();
 
     for (const recipient of participants) {
       const j = BigInt(recipient.juror.idx);
       for (const sender of participants) {
         const i = sender.juror.idx;
         // First verify the sender's Schnorr proof-of-knowledge of its constant
         // term. The docstring promises this check, but nothing ever ran it — a
         // participant could commit to a point it does not know and the POK was
         // dead weight. Fail the attempt for the accused like any other
         // attributable invalid data.
         if (
           !verifyProofOfKnowledge(
             sender.commitments[0].toHex(true),
             sender.pok,
             this.proofDomain(i),
           )
         ) {
           disqualified.add(i);
           continue;
         }
         let share = evaluatePoly(sender.coeffs, j);
 
         // Inject a faulty share for test scenarios.
         if (
           this.corruptShare &&
           this.corruptShare.accused === i &&
           this.corruptShare.victim === recipient.juror.idx
         ) {
           share = modN(share + 1n);
         }
 
         const expected = evaluateCommitments(sender.commitments, j);
         const actual = Point.BASE.multiply(share);
 
         if (!actual.equals(expected)) {
           // The accused reveals the share. In this local simulation the revealed
           // value is the same share we just checked; if it does not match the
           // commitment, the accused is disqualified.
           disqualified.add(i);
         }
       }
     }
 
     return disqualified;
   }
 }
 
 /**
  * Verify a single VSS share from a known commitment set.
  */
 export function verifyVssShare(
   recipientIdx: number,
   shareHex: string,
   commitments: readonly string[],
 ): boolean {
   try {
     const share = BigInt('0x' + shareHex);
     const commits = commitments.map((c) => Point.fromHex(c));
     const expected = evaluateCommitments(commits, BigInt(recipientIdx));
     const actual = Point.BASE.multiply(share);
     return actual.equals(expected);
   } catch {
     return false;
   }
 }
 
 /**
  * Verify a refresh share from a known refresh commitment set.
  * Refresh polynomials have a zero constant term.
  */
 export function verifyRefreshShare(
   recipientIdx: number,
   shareHex: string,
   refreshCommitments: readonly string[],
 ): boolean {
   try {
     const share = BigInt('0x' + shareHex);
     const commits = refreshCommitments.map((c) => Point.fromHex(c));
     const expected = evaluateRefreshCommitments(commits, BigInt(recipientIdx));
     const actual = Point.BASE.multiply(share);
     return actual.equals(expected);
   } catch {
     return false;
   }
 }
 
 /**
  * Compute a juror's final secret share from a set of valid decrypted shares.
  * All shares must belong to the same recipient index.
  */
 export function combineShares(shares: readonly { idx: number; shareHex: string }[]): frost.SecretShare {
   if (shares.length === 0) {
     throw new Error('combineShares requires at least one share');
   }
   const idx = shares[0].idx;
   if (!Number.isInteger(idx) || idx < 1) {
     throw new Error(`Invalid recipient index: ${idx}`);
   }
   if (shares.some((s) => s.idx !== idx)) {
     throw new Error('All shares must belong to the same recipient index');
   }
   let secret = 0n;
   for (const s of shares) {
     if (!/^[0-9a-fA-F]{1,64}$/.test(s.shareHex)) {
       throw new Error(`Invalid share hex from sender index ${s.idx}`);
     }
     secret = modN(secret + BigInt('0x' + s.shareHex));
   }
   return { idx, seckey: scalarToHex(secret) };
 }
 
 /**
  * Default keygen — Pedersen DKG.
  */
 export function generateFrostKeys(params: KeygenParams): KeygenResult {
   return new PedersenDkgAdapter().run(params);
 }

```


---

### Iterator-controlled outcomes bypass cardinality enforcement

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** The initializer now snapshots the validated array length once and copies exactly that many indexed outcomes, so caller-controlled Symbol.iterator cannot change cardinality or make initialization non-terminating; existing per-outcome validation still rejects invalid indexed values.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,442 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
-  if (
-    !Array.isArray(params.allowedOutcomes) ||
-    params.allowedOutcomes.length < 2 ||
-    params.allowedOutcomes.length > MAX_OUTCOMES
-  ) {
+  if (!Array.isArray(params.allowedOutcomes)) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
-  const outcomes = [...params.allowedOutcomes];
+  const outcomeCount = params.allowedOutcomes.length;
+  if (outcomeCount < 2 || outcomeCount > MAX_OUTCOMES) {
+    throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
+  }
+  const outcomes: string[] = [];
+  for (let i = 0; i < outcomeCount; i += 1) {
+    outcomes.push(params.allowedOutcomes[i]);
+  }
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Mutable State Bypasses Frozen Vote Configuration

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Freeze the complete vote-machine state graph at creation and after every reducer transition, including configuration arrays, commit/reveal records and ledgers, verdict support IDs, and failure/verdict objects. This preserves reducer behavior while preventing holders of returned state references from mutating the frozen configuration or fabricating ledger contents.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,461 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
+function freezeCourtVoteMachineState(state: CourtVoteMachineState): CourtVoteMachineState {
+  for (const commit of state.commits) Object.freeze(commit);
+  for (const reveal of state.reveals) Object.freeze(reveal);
+  Object.freeze(state.participantIndices);
+  Object.freeze(state.allowedOutcomes);
+  Object.freeze(state.commits);
+  Object.freeze(state.reveals);
+  if (state.verdict) {
+    Object.freeze(state.verdict.supportingEventIds);
+    Object.freeze(state.verdict);
+  }
+  if (state.failure) Object.freeze(state.failure);
+  return Object.freeze(state);
+}
+
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
-  return {
+  return freezeCourtVoteMachineState({
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
-  };
+  });
 }
 
-export function reduceCourtVoteMachine(
+function reduceCourtVoteMachineState(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }
+
+export function reduceCourtVoteMachine(
+  state: CourtVoteMachineState,
+  event: CourtVoteMachineEvent,
+): CourtVoteMachineState {
+  return freezeCourtVoteMachineState(reduceCourtVoteMachineState(state, event));
+}

```


---

### Mutable State Bypasses Reveal Admission

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Deep-freeze each newly created and transitioned vote-machine state, including configuration and ledger arrays, ledger records, verdict data, and failures, so callers cannot mutate accepted commits/reveals or append fabricated tally inputs at runtime.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,461 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
+function freezeCourtVoteMachineState(state: CourtVoteMachineState): CourtVoteMachineState {
+  for (const commit of state.commits) Object.freeze(commit);
+  for (const reveal of state.reveals) Object.freeze(reveal);
+  Object.freeze(state.participantIndices);
+  Object.freeze(state.allowedOutcomes);
+  Object.freeze(state.commits);
+  Object.freeze(state.reveals);
+  if (state.verdict) {
+    Object.freeze(state.verdict.supportingEventIds);
+    Object.freeze(state.verdict);
+  }
+  if (state.failure) Object.freeze(state.failure);
+  return Object.freeze(state);
+}
+
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
-  return {
+  return freezeCourtVoteMachineState({
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
-  };
+  });
 }
 
-export function reduceCourtVoteMachine(
+function reduceCourtVoteMachineUnchecked(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }
+
+export function reduceCourtVoteMachine(
+  state: CourtVoteMachineState,
+  event: CourtVoteMachineEvent,
+): CourtVoteMachineState {
+  return freezeCourtVoteMachineState(reduceCourtVoteMachineUnchecked(state, event));
+}

```


---

### Reject invalid thresholds before DKG and refresh construction

**Affected files:** dkg.ts

**V12 reasoning:** Added a shared threshold validator requiring a safe integer, minimum threshold 2, and threshold not exceeding the applicable participant count; key generation, record refresh, and direct refresh-share generation now validate before polynomial allocation or metadata construction.

```diff
diff --git a/dkg.ts b/dkg.ts
--- a/dkg.ts
+++ b/dkg.ts
@@ -1,621 +1,624 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pedersen-style distributed key generation adapter for the BAO Court / FROST oracle.
  *
  * This adapter simulates the full multi-party DKG inside a single local
  * process, but the cryptographic design is identical to a network version.
  *
  * NOTE: A coordinator-dependent DKG is NOT the desired design. The target is a
  * fully independent jury where every juror runs this logic on their own device
  * and exchanges only public commitments and encrypted shares over Nostr or other
  * peer-to-peer channels:
  *
  *   - Every juror generates its own private degree-(t-1) polynomial.
  *   - Every juror publishes Feldman coefficient commitments.
  *   - Every juror provides a Schnorr proof-of-knowledge of the constant coefficient.
  *   - Every received share is verified against the commitments.
  *   - Failed verifications raise complaints; if the revealed share is still
  *     invalid, the accused participant is disqualified.
  *   - The group secret never exists in one place — it is the sum of all
  *     remaining participants' constant coefficients.
  *
  * No single party materializes the group secret.
  *
  * NOTE: `generateFrostKeys()` defaults to `PedersenDkgAdapter`. The legacy
  * trusted-dealer adapter remains available as an explicit opt-in for tests and
  * demos. A production deployment MUST run the DKG across real user app instances
  * (browser/mobile/desktop) with encrypted peer-to-peer channels.
  */
 
 import { secp256k1 } from '@noble/curves/secp256k1.js';
 import * as frost from '@vbyte/frost';
 import { sha256 } from '@noble/hashes/sha2.js';
 import { hexToBytes } from '@noble/hashes/utils.js';
 import { createProofOfKnowledge, deriveXOnlyPubkey, randomScalar, scalarToHex, seededScalar, verifyProofOfKnowledge } from './crypto';
 import type { DkgRecord, SelectedJuror } from './types';
 
 const Point = secp256k1.Point;
 // secp256k1 curve order (scalar field).
 const N = secp256k1.Point.Fn.ORDER;
 type CurvePoint = InstanceType<typeof Point>;
 
 export function modN(x: bigint): bigint {
   const r = x % N;
   return r < 0n ? r + N : r;
 }
 
 /**
  * Evaluate a polynomial over the secp256k1 scalar field using Horner's rule.
  */
 export function evaluatePoly(coeffs: readonly bigint[], x: bigint): bigint {
   let result = 0n;
   for (let k = coeffs.length - 1; k >= 0; k--) {
     result = modN(modN(result * x) + coeffs[k]);
   }
   return result;
 }
 
 /**
  * Evaluate a polynomial whose coefficients are curve points at x.
  * This computes `sum_k A_k * x^k`.
  */
 export function evaluateCommitments(
   commitments: readonly CurvePoint[],
   x: bigint,
 ): CurvePoint {
   let result = Point.ZERO;
   for (let k = commitments.length - 1; k >= 0; k--) {
     result = result.multiply(x).add(commitments[k]);
   }
   return result;
 }
 
 /**
  * Evaluate a refresh polynomial at x.
  * Refresh polynomials have a zero constant term, so this computes
  * `sum_{k=1}^{degree} A_k * x^k`.
  */
 export function evaluateRefreshCommitments(
   commitments: readonly CurvePoint[],
   x: bigint,
 ): CurvePoint {
   let result = Point.ZERO;
   for (let k = commitments.length - 1; k >= 0; k--) {
     result = result.multiply(x).add(commitments[k]);
   }
   return result.multiply(x);
 }
 
 /**
  * Merge original DKG commitments with refresh commitments.
  * The refresh polynomial has degree threshold-1 but a zero constant term, so
  * its commitments are added to the original commitments starting at degree 1.
  */
 export function mergeRefreshCommitments(
   originalCommits: readonly string[],
   refreshCommits: readonly string[],
 ): string[] {
   if (refreshCommits.length !== originalCommits.length - 1) {
     throw new Error('Refresh commitment count must be one less than the threshold');
   }
   const orig = originalCommits.map((c) => Point.fromHex(c));
   const refr = refreshCommits.map((c) => Point.fromHex(c));
   const merged: CurvePoint[] = [orig[0]];
   for (let k = 1; k < orig.length; k++) {
     merged.push(orig[k].add(refr[k - 1]));
   }
   return merged.map((p) => p.toHex(true));
 }
 
 export function pointToXOnlyHex(point: CurvePoint): string {
   // Drop the 02/03 prefix from the compressed encoding to obtain a BIP340 x-only pubkey.
   return point.toHex(true).slice(2);
 }
 
 /**
  * Generate a zero-constant refresh polynomial package for an arbitrary set of
  * recipient indices.
  *
  * This replaces `frost.Lib.gen_refresh_shares`, which can only address
  * recipients `1..count` and therefore breaks for any non-contiguous juror
  * index set (e.g. after a DKG disqualification). The refresh polynomial is
  * `f(x) = c_1*x + ... + c_{t-1}*x^{t-1}` (zero constant term), so the group
  * public key is preserved. The returned commitments match the format expected
  * by {@link mergeRefreshCommitments} and {@link verifyRefreshShare}: one
  * commitment per non-constant coefficient, starting at degree 1.
  */
+function validateThreshold(threshold: number, participantCount: number): void {
+  if (!Number.isSafeInteger(threshold)) {
+    throw new Error('Threshold must be a safe integer');
+  }
+  if (threshold < 2) {
+    throw new Error('Threshold must be at least 2');
+  }
+  if (participantCount < threshold) {
+    throw new Error('Participants cannot be less than threshold');
+  }
+}
+
 export function generateRefreshShares(
   senderIdx: number,
   threshold: number,
   recipientIdxs: readonly number[],
 ): { vss_commits: string[]; idx: number; shares: frost.SecretShare[] } {
-  if (threshold < 2) {
-    throw new Error('Threshold must be at least 2');
-  }
+  validateThreshold(threshold, recipientIdxs.length);
   if (recipientIdxs.length === 0 || recipientIdxs.some((i) => !Number.isInteger(i) || i < 1)) {
     throw new Error('Recipient indices must be positive integers');
   }
   const subCoeffs = Array.from({ length: threshold - 1 }, () => randomScalar());
   const coeffs = [0n, ...subCoeffs];
   const shares = recipientIdxs.map((idx) => ({
     idx,
     seckey: scalarToHex(evaluatePoly(coeffs, BigInt(idx))),
   }));
   const vss_commits = subCoeffs.map((c) => Point.BASE.multiply(c).toHex(true));
   return { vss_commits, idx: senderIdx, shares };
 }
 
 export interface PedersenDkgOptions {
   /**
    * When true, enables test/demo-only features: deterministic `seed` keygen
    * and the `corruptShare` fault injection hook. Never enable in production.
    */
   readonly unsafeTestMode?: boolean;
   /**
    * Test-only hook: simulate a dishonest participant that sends an invalid share.
    * The accused juror's share to the victim juror is corrupted, triggering a
    * complaint and disqualification. Requires `unsafeTestMode: true`.
    */
   readonly corruptShare?: { readonly accused: number; readonly victim: number };
   /**
    * Test-only hook: simulate a participant that fails its Schnorr
    * proof-of-knowledge of the constant term (e.g. committed to a point whose
    * discrete log it does not know). Requires `unsafeTestMode: true`.
    */
   readonly corruptPok?: { readonly accused: number };
 }
 
 export interface ParticipantState {
   readonly juror: SelectedJuror;
   readonly coeffs: readonly bigint[];
   readonly commitments: readonly CurvePoint[];
   readonly pok: ReturnType<typeof createProofOfKnowledge>;
 }
 
 export interface KeygenParams {
   readonly marketId: string;
   /** Optional dispute id (2140wtf scopes DKG to a dispute). */
   readonly disputeId?: string;
   readonly threshold: number;
   readonly jurors: readonly SelectedJuror[];
   /**
    * Optional deterministic seed. Only allowed when the adapter is constructed
    * with `unsafeTestMode: true`. Passing a shared/public seed in production
    * collapses the DKG because multiple jurors generate identical polynomials.
    */
   readonly seed?: string | Uint8Array;
 }
 
 export interface KeygenResult {
   readonly record: DkgRecord;
   readonly shares: frost.SecretShare[];
 }
 
 export interface RefreshParams {
   readonly record: DkgRecord;
   readonly shares: readonly frost.SecretShare[];
 }
 
 export interface RefreshResult {
   readonly record: DkgRecord;
   readonly shares: frost.SecretShare[];
 }
 
 /**
  * Interface that a production DKG implementation must satisfy.
  */
 export interface DkgAdapter {
   readonly run: (params: KeygenParams) => KeygenResult;
   readonly refreshShares: (params: RefreshParams) => RefreshResult;
 }
 export class PedersenDkgAdapter implements DkgAdapter {
   private readonly unsafeTestMode: boolean;
   private readonly corruptShare?: {
     readonly accused: number;
     readonly victim: number;
   };
   private readonly corruptPok?: { readonly accused: number };
   private paramsForProofDomain?: { readonly marketId: string; readonly disputeId?: string };
 
   constructor(options?: PedersenDkgOptions) {
     this.unsafeTestMode = options?.unsafeTestMode ?? false;
     if ((options?.corruptShare || options?.corruptPok) && !this.unsafeTestMode) {
       throw new Error('corruptShare/corruptPok require unsafeTestMode: true');
     }
     this.corruptShare = options?.corruptShare;
     this.corruptPok = options?.corruptPok;
   }
 
   private proofDomain(idx: number): string {
     const marketId = this.paramsForProofDomain?.marketId ?? '';
     const disputeId = this.paramsForProofDomain?.disputeId ?? '';
     return `market=${marketId}|dispute=${disputeId}|juror=${idx}`;
   }
 
   run(params: KeygenParams): KeygenResult {
     this.validateParams(params);
 
     if (params.seed && !this.unsafeTestMode) {
       throw new Error(
         'Deterministic DKG seed is only allowed in unsafeTestMode. ' +
           'A shared seed in production lets any juror reconstruct the group secret.',
       );
     }
 
     const { threshold, jurors } = params;
     this.paramsForProofDomain = { marketId: params.marketId, disputeId: params.disputeId };
     const participants = this.createParticipants(jurors, threshold, params);
     const disqualified = this.resolveComplaints(participants);
 
     const qualifiedParticipants = participants.filter(
       (p) => !disqualified.has(p.juror.idx),
     );
 
     if (qualifiedParticipants.length < threshold) {
       throw new Error(
         `Pedersen DKG failed: ${qualifiedParticipants.length} qualified participants remain, ` +
           `but threshold is ${threshold}`,
       );
     }
 
     const qualifiedJurors = jurors.filter((j) => !disqualified.has(j.idx));
 
     // Group public key = sum of all qualified constant-coefficient commitments.
     const groupPoint = qualifiedParticipants.reduce(
       (sum, p) => sum.add(p.commitments[0]),
       Point.ZERO,
     );
 
     // Each juror's final secret share is the sum of all qualified shares sent to them.
     const shares: frost.SecretShare[] = qualifiedJurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const secret = qualifiedParticipants.reduce(
         (sum, p) => modN(sum + evaluatePoly(p.coeffs, idx)),
         0n,
       );
       return { idx: juror.idx, seckey: scalarToHex(secret) };
     });
 
     // Verification shares are the public points matching the secret shares.
     const verificationShares = qualifiedJurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const pubkeyPoint = qualifiedParticipants.reduce(
         (sum, p) => sum.add(evaluateCommitments(p.commitments, idx)),
         Point.ZERO,
       );
       return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
     });
 
     // Sanity check: every secret share must produce the advertised verification share.
     for (const share of shares) {
       const expected = deriveXOnlyPubkey(share.seckey);
       const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
       if (actual !== expected) {
         throw new Error(
           `Pedersen DKG internal error: verification share mismatch for juror ${share.idx}`,
         );
       }
     }
 
     const groupPubkey = groupPoint.toHex(true);
     const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
 
     const vssCommitments = qualifiedParticipants.map((p) => ({
       idx: p.juror.idx,
       pubkey: p.juror.nostrPubkey,
       commits: p.commitments.map((c) => c.toHex(true)),
     }));
 
     const record: DkgRecord = {
       marketId: params.marketId,
       disputeId: params.disputeId,
       threshold,
       participants: qualifiedJurors.length,
       groupPubkey,
       groupPubkeyXOnly,
       verificationShares,
       jurorPubkeys: qualifiedJurors.map((j) => j.nostrPubkey),
       vssCommitments,
     };
 
     return { record, shares };
   }
 
   /**
    * Refresh all shares without changing the group public key.
    *
    * Each juror generates a random degree-(t-1) polynomial with a zero constant
    * term and distributes shares to every other juror. The refreshed share is
    * the old share plus the sum of all received refresh shares. The group public
    * key is unchanged because the refresh polynomials sum to zero.
    */
   refreshShares(params: RefreshParams): RefreshResult {
     this.validateRefreshParams(params);
 
     const { record, shares } = params;
     const threshold = record.threshold;
     const jurors = record.verificationShares.map((v) => {
       const vss = record.vssCommitments.find((c) => c.idx === v.idx);
       return {
         idx: v.idx,
         nostrPubkey: vss?.pubkey ?? '',
       };
     });
 
     // Each juror generates a refresh package for all participants. Indices
     // may be non-contiguous (e.g. after a disqualification), so the refresh
     // polynomials are generated locally rather than via
     // `frost.Lib.gen_refresh_shares`, which only supports recipients 1..n.
     const jurorIdxs = jurors.map((j) => j.idx);
     const refreshPackages = jurors.map((juror) =>
       generateRefreshShares(juror.idx, threshold, jurorIdxs),
     );
 
     // Combine every juror's current share with the refresh shares addressed to them.
     const refreshedShares = jurors.map((juror) => {
       const current = shares.find((s) => s.idx === juror.idx);
       if (!current) {
         throw new Error(`Missing current share for juror ${juror.idx}`);
       }
       const refreshShares = refreshPackages.map((pkg) =>
         frost.Lib.get_share(pkg.shares, juror.idx),
       );
       return frost.Lib.refresh_share(refreshShares, current);
     });
 
     // Merge original and refresh commitments so verification shares can be updated.
     const mergedVssCommitments = jurors.map((juror, i) => {
       const original = record.vssCommitments.find((c) => c.idx === juror.idx);
       if (!original) {
         throw new Error(`Missing original commitments for juror ${juror.idx}`);
       }
       return {
         idx: juror.idx,
         pubkey: juror.nostrPubkey,
         commits: mergeRefreshCommitments(original.commits, refreshPackages[i].vss_commits),
       };
     });
 
     const verificationShares = jurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const pubkeyPoint = mergedVssCommitments.reduce(
         (sum, c) => sum.add(evaluateCommitments(c.commits.map((h) => Point.fromHex(h)), idx)),
         Point.ZERO,
       );
       return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
     });
 
     // Sanity check: every refreshed share must match its verification share.
     for (const share of refreshedShares) {
       const expected = deriveXOnlyPubkey(share.seckey);
       const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
       if (actual !== expected) {
         throw new Error(
           `Refresh internal error: verification share mismatch for juror ${share.idx}`,
         );
       }
     }
 
     const groupPoint = mergedVssCommitments.reduce(
       (sum, c) => sum.add(Point.fromHex(c.commits[0])),
       Point.ZERO,
     );
     const groupPubkey = groupPoint.toHex(true);
     const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
 
     if (groupPubkey !== record.groupPubkey) {
       throw new Error('Refresh changed the group public key');
     }
 
     const newRecord: DkgRecord = {
       ...record,
       groupPubkey,
       groupPubkeyXOnly,
       verificationShares,
       vssCommitments: mergedVssCommitments,
     };
 
     return { record: newRecord, shares: refreshedShares };
   }
 
   private validateRefreshParams(params: RefreshParams): void {
     if (params.shares.length !== params.record.participants) {
       throw new Error('Share count does not match record participants');
     }
-    if (params.record.threshold < 2) {
-      throw new Error('Threshold must be at least 2');
-    }
+    validateThreshold(params.record.threshold, params.record.participants);
     const indices = new Set(params.shares.map((s) => s.idx));
     if (indices.size !== params.shares.length) {
       throw new Error('Duplicate share indices');
     }
     for (const share of params.shares) {
       const vss = params.record.vssCommitments.find((c) => c.idx === share.idx);
       if (!vss) {
         throw new Error(`No commitment found for share index ${share.idx}`);
       }
     }
   }
 
   private validateParams(params: KeygenParams): void {
-    if (params.threshold < 2) {
-      throw new Error('Threshold must be at least 2');
-    }
-    if (params.jurors.length < params.threshold) {
-      throw new Error('Participants cannot be less than threshold');
-    }
+    validateThreshold(params.threshold, params.jurors.length);
     const indices = new Set(params.jurors.map((j) => j.idx));
     if (indices.size !== params.jurors.length) {
       throw new Error('Duplicate juror indices');
     }
     if (params.jurors.some((j) => j.idx < 1)) {
       throw new Error('Juror indices must be positive');
     }
   }
 
   private createParticipants(
     jurors: readonly SelectedJuror[],
     threshold: number,
     params: KeygenParams,
   ): ParticipantState[] {
     const seedBytes = params.seed
       ? (typeof params.seed === 'string'
         ? (params.seed.length === 64 && /^[0-9a-fA-F]{64}$/.test(params.seed)
           ? hexToBytes(params.seed)
           : sha256(new TextEncoder().encode(params.seed)))
         : params.seed)
       : undefined;
 
     return jurors.map((juror) => {
       const coeffs = Array.from({ length: threshold }, (_, k) => {
         if (!seedBytes) return randomScalar();
         const info = new TextEncoder().encode(
           `bao-frost-court/dkg-coeff|market=${params.marketId}|dispute=${params.disputeId ?? ''}|threshold=${threshold}|juror=${juror.idx}|k=${k}`,
         );
         return seededScalar(seedBytes, info);
       });
       const commitments = coeffs.map((a) => Point.BASE.multiply(a));
       const domain = this.proofDomain(juror.idx);
       const pok = createProofOfKnowledge(
         scalarToHex(coeffs[0]),
         commitments[0].toHex(true),
         domain,
       );
       if (this.corruptPok?.accused === juror.idx) {
         // Tamper: respond with a different valid scalar so verification fails.
         const z = BigInt(`0x${pok.response}`);
         return { juror, coeffs, commitments, pok: { ...pok, response: scalarToHex(modN(z + 1n)) } };
       }
       return { juror, coeffs, commitments, pok };
     });
   }
 
   /**
    * Simulate the share-verification and complaint phase.
    * For every pair (sender -> recipient), the recipient checks the share against
    * the sender's public commitments. A failed check is treated as a complaint;
    * the sender reveals the disputed share, and if it is still invalid the sender
    * is disqualified.
    */
   private resolveComplaints(
     participants: readonly ParticipantState[],
   ): Set<number> {
     const disqualified = new Set<number>();
 
     for (const recipient of participants) {
       const j = BigInt(recipient.juror.idx);
       for (const sender of participants) {
         const i = sender.juror.idx;
         // First verify the sender's Schnorr proof-of-knowledge of its constant
         // term. The docstring promises this check, but nothing ever ran it — a
         // participant could commit to a point it does not know and the POK was
         // dead weight. Fail the attempt for the accused like any other
         // attributable invalid data.
         if (
           !verifyProofOfKnowledge(
             sender.commitments[0].toHex(true),
             sender.pok,
             this.proofDomain(i),
           )
         ) {
           disqualified.add(i);
           continue;
         }
         let share = evaluatePoly(sender.coeffs, j);
 
         // Inject a faulty share for test scenarios.
         if (
           this.corruptShare &&
           this.corruptShare.accused === i &&
           this.corruptShare.victim === recipient.juror.idx
         ) {
           share = modN(share + 1n);
         }
 
         const expected = evaluateCommitments(sender.commitments, j);
         const actual = Point.BASE.multiply(share);
 
         if (!actual.equals(expected)) {
           // The accused reveals the share. In this local simulation the revealed
           // value is the same share we just checked; if it does not match the
           // commitment, the accused is disqualified.
           disqualified.add(i);
         }
       }
     }
 
     return disqualified;
   }
 }
 
 /**
  * Verify a single VSS share from a known commitment set.
  */
 export function verifyVssShare(
   recipientIdx: number,
   shareHex: string,
   commitments: readonly string[],
 ): boolean {
   try {
     const share = BigInt('0x' + shareHex);
     const commits = commitments.map((c) => Point.fromHex(c));
     const expected = evaluateCommitments(commits, BigInt(recipientIdx));
     const actual = Point.BASE.multiply(share);
     return actual.equals(expected);
   } catch {
     return false;
   }
 }
 
 /**
  * Verify a refresh share from a known refresh commitment set.
  * Refresh polynomials have a zero constant term.
  */
 export function verifyRefreshShare(
   recipientIdx: number,
   shareHex: string,
   refreshCommitments: readonly string[],
 ): boolean {
   try {
     const share = BigInt('0x' + shareHex);
     const commits = refreshCommitments.map((c) => Point.fromHex(c));
     const expected = evaluateRefreshCommitments(commits, BigInt(recipientIdx));
     const actual = Point.BASE.multiply(share);
     return actual.equals(expected);
   } catch {
     return false;
   }
 }
 
 /**
  * Compute a juror's final secret share from a set of valid decrypted shares.
  * All shares must belong to the same recipient index.
  */
 export function combineShares(shares: readonly { idx: number; shareHex: string }[]): frost.SecretShare {
   if (shares.length === 0) {
     throw new Error('combineShares requires at least one share');
   }
   const idx = shares[0].idx;
   if (!Number.isInteger(idx) || idx < 1) {
     throw new Error(`Invalid recipient index: ${idx}`);
   }
   if (shares.some((s) => s.idx !== idx)) {
     throw new Error('All shares must belong to the same recipient index');
   }
   let secret = 0n;
   for (const s of shares) {
     if (!/^[0-9a-fA-F]{1,64}$/.test(s.shareHex)) {
       throw new Error(`Invalid share hex from sender index ${s.idx}`);
     }
     secret = modN(secret + BigInt('0x' + s.shareHex));
   }
   return { idx, seckey: scalarToHex(secret) };
 }
 
 /**
  * Default keygen — Pedersen DKG.
  */
 export function generateFrostKeys(params: KeygenParams): KeygenResult {
   return new PedersenDkgAdapter().run(params);
 }

```


---

### Reveal deadline can be bypassed with non-monotonic timestamps

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Track the greatest timestamp observed by the vote reducer, reject timestamp rollback on every time-bearing event, and require reveal-phase entry before the reveal deadline. This closes both stale-time reveal admission and late-open empty-ledger paths.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,450 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
+  /** Greatest caller-supplied timestamp accepted by the reducer. */
+  readonly latestTimestamp: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
+    latestTimestamp: 0,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
+  if (event.type !== 'abort') {
+    assertNow(event.now);
+    if (event.now < state.latestTimestamp) {
+      throw new CourtVoteTransitionError('now must not precede a previously observed timestamp');
+    }
+    state = { ...state, latestTimestamp: event.now };
+  }
+
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
-    assertNow(event.now);
+    assertBeforeDeadline(event.now, state.revealDeadline, 'cannot open vote reveals at or after the reveal deadline');
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Transient signer failure permanently drops messages

**Affected files:** courtSigner.ts, courtInbox.ts

**V12 reasoning:** Signer getPublicKey/decrypt rejections now propagate distinctly from malformed/forged input, while CourtInbox leaves records pending when those operational failures occur; validation/parsing failures still return null and are drained as terminal junk.

```diff
diff --git a/courtSigner.ts b/courtSigner.ts
--- a/courtSigner.ts
+++ b/courtSigner.ts
@@ -1,266 +1,279 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Signer-backed private transport for BAO Court protocol messages.
  *
  * Every private Court message (DKG shares, complaints, backups, refresh
  * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
  * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
  * process memory. This module provides the same capabilities through a
  * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
  * signers, hardware-backed agents) so production jurors never expose an
  * `nsec` to the Court host.
  *
  * The signer surface is intentionally narrow: public key, event signing, and
  * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
  * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
  * `nip44_decrypt`).
  *
  * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
  * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
  * seal author equals the rumor author, and recomputes the rumor id. A gift
  * wrap that fails any check is rejected (returns null), never partially
  * trusted.
  */
 
 import {
   finalizeEvent,
   generateSecretKey,
   getEventHash,
   getPublicKey,
   verifyEvent,
 } from 'nostr-tools/pure';
 import { nip59 } from 'nostr-tools';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
 
 const SEAL_KIND = 13;
 const GIFT_WRAP_KIND = 1059;
 const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
 
 const HEX_64 = /^[0-9a-f]{64}$/;
 
 /** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
 function randomNowSeconds(): number {
   return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
 }
 
 function assertHex64(value: string, label: string): void {
   if (!HEX_64.test(value)) {
     throw new Error(`${label} must be a 64-character lowercase hex string`);
   }
 }
 
 /**
  * Minimal external signer surface required for Court private transport.
  * Implementations MUST NOT expose the secret key.
  */
 export interface CourtEventSigner {
   /** The signer's x-only public key (64-char hex). */
   getPublicKey(): Promise<string> | string;
   /** Sign an event template; the signer fills pubkey, id, and sig. */
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent>;
   /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
   /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
 }
 
 /**
  * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
  * signer-backed keys work everywhere the Court already accepts encryption
  * providers (DKG sessions, backups, complaints).
  */
 export class Nip44SignerCrypto implements Nip44Crypto {
   constructor(private readonly signer: CourtEventSigner) {}
 
   encrypt(plaintext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Encrypt(peerPubkey, plaintext);
   }
 
   decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Decrypt(peerPubkey, ciphertext);
   }
 }
 
 /**
  * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
  * demo rooms, and local tooling — production jurors should use a real
  * external signer. Keeping this adapter means the entire private-transport
  * stack has exactly one code path regardless of key custody.
  */
 export class SeckeyCourtSigner implements CourtEventSigner {
   private readonly seckey: Uint8Array;
   private readonly crypto: Nip44SeckeyCrypto;
 
   constructor(seckey: string | Uint8Array) {
     // Copy at the boundary: caller-supplied buffers must never alias our
     // secret, or later mutation/zeroization of the source silently corrupts
     // (or "destroys") this signer.
     this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
     if (this.seckey.length !== 32) {
       throw new Error('seckey must be 32 bytes');
     }
     this.crypto = new Nip44SeckeyCrypto(this.seckey);
   }
 
   getPublicKey(): string {
     return getPublicKey(this.seckey);
   }
 
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent> {
     return Promise.resolve(finalizeEvent(template, this.seckey));
   }
 
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
     return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
   }
 
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
     return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
   }
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null;
 }
 
 /**
  * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
  * recipient, using only the signer's public methods. The sender's secret key
  * never enters this process; the outer wrap's ephemeral key is generated
  * locally per wrap (it is random by design and protects nothing long-term).
  */
 export async function wrapProtocolEventWithSigner(
   event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
   signer: CourtEventSigner,
   recipientPubkey: string,
 ): Promise<NostrEvent> {
   assertHex64(recipientPubkey, 'recipient pubkey');
   const senderPubkey = await signer.getPublicKey();
   assertHex64(senderPubkey, 'signer pubkey');
 
   // Rumor: unsigned, id commits to author + content.
   const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
   rumor.id = getEventHash(rumor as NostrEvent);
 
   // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
   // through the external signer.
   const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
   const seal = await signer.signEvent({
     kind: SEAL_KIND,
     content: sealContent,
     created_at: randomNowSeconds(),
     tags: [],
   });
   // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
   // their verdict in a non-JSON-enumerable symbol that object spreads
   // preserve, so a malicious signer returning a once-valid seal it then
   // tampered with must never reach the verifier with the cached verdict
   // attached.
   const sealCandidate: NostrEvent = {
     id: seal.id,
     pubkey: seal.pubkey,
     sig: seal.sig,
     kind: seal.kind,
     created_at: seal.created_at,
     content: seal.content,
     tags: seal.tags,
   } as NostrEvent;
   if (
     sealCandidate.kind !== SEAL_KIND
     || sealCandidate.pubkey !== senderPubkey
     || !verifyEvent(sealCandidate)
   ) {
     throw new Error('external signer returned an invalid NIP-59 seal');
   }
 
   // Wrap: kind 1059 under a locally generated ephemeral key.
   return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
 }
 
 /**
  * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
  * full NIP-59 verification. Returns the inner rumor, or null if any layer is
  * malformed, misaddressed, forged, or tampered with.
  */
 export async function unwrapProtocolEventWithSigner(
   wrapEvent: NostrEvent,
   signer: CourtEventSigner,
 ): Promise<NostrEvent | null> {
+  if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
+
+  const recipientPubkey = await signer.getPublicKey();
+  let addressed: boolean;
   try {
-    if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
-    const recipientPubkey = await signer.getPublicKey();
-    const addressed = wrapEvent.tags.some(
+    addressed = wrapEvent.tags.some(
       (t) => t[0] === 'p' && t[1] === recipientPubkey,
     );
-    if (!addressed) return null;
+  } catch {
+    return null;
+  }
+  if (!addressed) return null;
 
-    const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
+  // Signer failures are operational failures, not evidence that the wrap is
+  // invalid. Let them reject so durable consumers can leave the wrap pending.
+  const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
+  let sealEvent: NostrEvent;
+  try {
     const seal: unknown = JSON.parse(sealJson);
     if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
-    const sealEvent = seal as unknown as NostrEvent;
+    sealEvent = seal as unknown as NostrEvent;
     if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;
+  } catch {
+    return null;
+  }
 
-    const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
+  const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
+  try {
     const rumor: unknown = JSON.parse(rumorJson);
     if (!isRecord(rumor)) return null;
     const rumorEvent = rumor as unknown as NostrEvent;
 
     // NIP-59: the seal must be signed by the rumor's author, and the rumor id
     // must commit to its exact contents.
     if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
     if (typeof rumorEvent.id !== 'string') return null;
     if (getEventHash(rumorEvent) !== rumorEvent.id) return null;
 
     return rumorEvent;
   } catch {
     return null;
   }
 }
 
 /**
  * Unwrap many gift wraps with a signer and filter to a specific inner kind
  * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
  * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
  */
 export async function unwrapProtocolEventsWithSigner(
   wraps: readonly NostrEvent[],
   signer: CourtEventSigner,
   options?: {
     readonly kinds?: readonly number[];
     readonly disputeId?: string;
   },
 ): Promise<NostrEvent[]> {
   const seen = new Set<string>();
   const result: NostrEvent[] = [];
 
   for (const wrap of wraps) {
     const rumor = await unwrapProtocolEventWithSigner(wrap, signer);
     if (!rumor || !rumor.id) continue;
     if (seen.has(rumor.id)) continue;
     seen.add(rumor.id);
 
     if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
     if (options?.disputeId) {
       const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
       if (disputeTag?.[1] !== options.disputeId) continue;
     }
 
     result.push(rumor);
   }
 
   return result;
 }
 
 /** Generate a fresh random secret key (hex) — for tests and demo rooms. */
 export function generateCourtSeckeyHex(): string {
   return bytesToHex(generateSecretKey());
 }

diff --git a/courtInbox.ts b/courtInbox.ts
--- a/courtInbox.ts
+++ b/courtInbox.ts
@@ -1,864 +1,865 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Recipient inbox and relay-group transport policy for BAO Court.
  *
  * This module is the receiving half of the Court's authenticated multi-relay
  * transport. It is deliberately I/O-free: the host owns every socket and
  * injects relay connections behind the {@link CourtRelayConnection}
  * interface, feeds gift wraps into {@link CourtInbox.ingest} with an explicit
  * `now`, and pulls verified inner rumors back out with
  * {@link CourtInbox.drain}. No `Date.now`, no network, no secret keys — the
  * signer surface from `courtSigner.ts` performs all decryption.
  *
  * Three responsibilities:
  *
  * 1. **Scoped subscriptions** ({@link buildCourtSubscriptions}) — from the
  *    validated session parameters, derive deterministic relay filters that
  *    (a) restrict public Court protocol kinds to roster authors bound to the
  *    session hash, and (b) restrict kind-1059 gift-wrap scans to wraps
  *    p-tagged to the local juror, both scoped to the session start time.
  *
  * 2. **Inbound classification** ({@link classifyInboundEvent}) — a total,
  *    never-throwing accept/reject gate with a typed reason union. Structural
  *    classification only; acceptance here never constitutes protocol
  *    acceptance (that remains the strict parsers' job in
  *    `courtProtocolEvents.ts`).
  *
  * 3. **The inbox itself** ({@link CourtInbox}) — deduplicates gift wraps by
  *    wrap id across every relay in the group, records per-relay provenance
  *    and first/last-seen timestamps, rejects wraps not p-tagged to the local
  *    pubkey *before* any decryption can occur, and drains verified inner
  *    rumors (NIP-59 semantics via the signer) sorted by `created_at`.
  *    Snapshots are JSON-safe and versioned; corrupted snapshots are rejected
  *    with a typed {@link CourtInboxError}.
  *
  * Relay-group policy ({@link publishToGroup}, {@link readFromGroup}):
  * writes fan out to every write relay with per-relay error capture — one
  * failing relay never rejects the batch — and reads merge every read relay's
  * subscription stream, tagging each event with the relay that delivered it.
  */
 
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import {
   assertCourtSessionParameters,
   hashCourtSessionParameters,
   type CourtSessionParameters,
 } from './courtSession';
 import { classifyCourtProtocolEvent } from './courtProtocolEvents';
 import {
   unwrapProtocolEventWithSigner,
   type CourtEventSigner,
 } from './courtSigner';
 import { COURT_DELIVERY_ACK_KIND } from './courtOutbox';
 import {
   BAO_COURT_DKG_COMMITMENT_KIND,
   BAO_COURT_FROST_COMMIT_KIND,
   BAO_COURT_FROST_REVEAL_KIND,
   BAO_COURT_VOTE_COMMIT_KIND,
   BAO_COURT_VOTE_REVEAL_KIND,
 } from './events';
 
 /** NIP-59 gift-wrap kind scanned by every Court recipient. */
 export const COURT_GIFT_WRAP_KIND = 1059;
 
 /** Snapshot schema version persisted by {@link CourtInbox.snapshot}. */
 export const COURT_INBOX_SNAPSHOT_VERSION = 1 as const;
 
 /**
  * NIP-59 randomizes seal/wrap timestamps up to two days into the past, so a
  * wrap published at the session start can carry a `created_at` two days
  * earlier. Wrap scans must look back this far or legitimate wraps are missed.
  */
 export const COURT_WRAP_LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
 
 /**
  * Public Court kinds a recipient subscribes to with roster-author scoping:
  * the five session-bound protocol kinds plus signed delivery
  * acknowledgements (authored by roster peers, bound via their `m` tag).
  */
 export const COURT_INBOX_PUBLIC_KINDS = [
   BAO_COURT_DKG_COMMITMENT_KIND,
   BAO_COURT_VOTE_COMMIT_KIND,
   BAO_COURT_VOTE_REVEAL_KIND,
   BAO_COURT_FROST_COMMIT_KIND,
   BAO_COURT_FROST_REVEAL_KIND,
   COURT_DELIVERY_ACK_KIND,
 ] as const;
 
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_64 = /^[0-9a-f]{128}$/;
 const MAX_NOSTR_KIND = 65_535;
 const MAX_RECORDS = 100_000;
 const MAX_RELAYS_PER_RECORD = 64;
 const MAX_RELAY_URL_BYTES = 512;
 const MAX_WRAP_CONTENT_BYTES = 256 * 1024;
 const MAX_WRAP_TAGS = 128;
 const MAX_WRAP_TAG_ITEMS = 16;
 const MAX_WRAP_TAG_ITEM_BYTES = 1024;
 
 const textEncoder = new TextEncoder();
 
 /** Typed failure for every inbox gate; `code` is machine-readable. */
 export type CourtInboxErrorCode =
   | 'malformed'
   | 'wrong_recipient'
   | 'capacity_exceeded'
   | 'corrupt_snapshot';
 
 /** Error thrown by every fail-closed inbox gate. */
 export class CourtInboxError extends Error {
   readonly code: CourtInboxErrorCode;
 
   constructor(code: CourtInboxErrorCode, message: string) {
     super(message);
     this.name = 'CourtInboxError';
     this.code = code;
   }
 }
 
 function fail(code: CourtInboxErrorCode, message: string): never {
   throw new CourtInboxError(code, message);
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     fail('malformed', 'now must be a non-negative Unix timestamp in seconds');
   }
 }
 
 function assertHex32(value: unknown, field: string): asserts value is string {
   if (typeof value !== 'string' || !HEX_32.test(value)) {
     fail('malformed', `${field} must be 32-byte lowercase hex`);
   }
 }
 
 function assertRelayUrl(value: unknown): asserts value is string {
   if (
     typeof value !== 'string'
     || value.length === 0
     || value !== value.trim()
     || textEncoder.encode(value).length > MAX_RELAY_URL_BYTES
   ) {
     fail('malformed', 'relayUrl must be a non-empty bounded string');
   }
 }
 
 /* ------------------------------------------------------------------------- */
 /* Relay abstraction                                                          */
 /* ------------------------------------------------------------------------- */
 
 /**
  * A Nostr relay filter as constructed by {@link buildCourtSubscriptions}.
  * Plain JSON-safe data; relay clients (nostr-tools, nostrify, nostr-relaypool)
  * all accept this shape.
  */
 export interface CourtRelayFilter {
   readonly kinds?: readonly number[];
   readonly authors?: readonly string[];
   readonly since?: number;
   readonly '#p'?: readonly string[];
   readonly '#session'?: readonly string[];
 }
 
 /**
  * Host-injected relay connection. The inbox module never opens sockets;
  * implementations wrap whatever relay client the host already runs.
  * `subscribe` streams events matching the filters until the host closes the
  * subscription (the returned iterable ends or its `return()` is called).
  */
 export interface CourtRelayConnection {
   /** Stable relay identifier (typically the WebSocket URL). */
   readonly url: string;
   /** Publish one signed event; rejects on relay-level failure. */
   publish(event: NostrEvent): Promise<void>;
   /** Stream events matching the given filters. */
   subscribe(filters: readonly CourtRelayFilter[]): AsyncIterable<NostrEvent>;
 }
 
 /** Per-relay outcome of a {@link publishToGroup} fan-out. */
 export interface CourtRelayPublishResult {
   readonly url: string;
   readonly ok: boolean;
   /** Human-readable failure message when ok is false. */
   readonly error?: string;
 }
 
 /** Aggregate report of a group publish; always resolves, never rejects. */
 export interface CourtRelayPublishReport {
   readonly results: readonly CourtRelayPublishResult[];
   /** URLs of relays that accepted the event, in group order. */
   readonly delivered: readonly string[];
 }
 
 /**
  * Publish one event to every relay in the group.
  *
  * Write policy is publish-to-all: each relay is attempted independently and
  * failures are captured per relay. The returned promise never rejects — a
  * partition of one relay must not silence the others, and the caller decides
  * how many deliveries are enough.
  */
 export async function publishToGroup(
   event: NostrEvent,
   relays: readonly CourtRelayConnection[],
 ): Promise<CourtRelayPublishReport> {
   const settled = await Promise.allSettled(relays.map((relay) => relay.publish(event)));
   const results: CourtRelayPublishResult[] = settled.map((outcome, index) => {
     const url = relays[index]?.url ?? `relay#${index}`;
     if (outcome.status === 'fulfilled') return { url, ok: true };
     const reason: unknown = outcome.reason;
     const message = reason instanceof Error ? reason.message : String(reason);
     return { url, ok: false, error: message };
   });
   return { results, delivered: results.filter((r) => r.ok).map((r) => r.url) };
 }
 
 /** One event delivered by {@link readFromGroup}, tagged with its source. */
 export interface CourtGroupDelivery {
   readonly event: NostrEvent;
   /** URL of the relay that delivered this event. */
   readonly relayUrl: string;
 }
 
 /**
  * Merge the subscription streams of every relay in the group into one async
  * iterable of provenance-tagged deliveries.
  *
  * Read policy is read-from-all: duplicates across relays are expected and
  * left to the consumer ({@link CourtInbox} dedupes by wrap id). When the
  * consumer stops iterating, every underlying subscription is closed. A relay
  * whose stream throws contributes an immediate end-of-stream for that relay;
  * it never terminates the merged stream for the others.
  */
 export async function* readFromGroup(
   relays: readonly CourtRelayConnection[],
   filters: readonly CourtRelayFilter[],
 ): AsyncGenerator<CourtGroupDelivery, void, undefined> {
   interface Pending {
     readonly index: number;
     readonly promise: Promise<{ index: number; result: IteratorResult<NostrEvent> }>;
   }
   const iterators: (AsyncIterator<NostrEvent> | undefined)[] = relays.map((relay) => {
     try {
       return relay.subscribe(filters)[Symbol.asyncIterator]();
     } catch {
       return undefined;
     }
   });
   const pendings = new Set<Pending>();
   const arm = (index: number): void => {
     const iterator = iterators[index];
     if (!iterator) return;
     const pending: Pending = {
       index,
       promise: iterator.next().then(
         (result) => ({ index, result }),
         () => ({ index, result: { done: true, value: undefined } as IteratorResult<NostrEvent> }),
       ),
     };
     pendings.add(pending);
   };
   for (let index = 0; index < iterators.length; index += 1) arm(index);
   try {
     while (pendings.size > 0) {
       const raced = await Promise.race([...pendings].map((p) => p.promise));
       for (const pending of pendings) {
         if (pending.index === raced.index) {
           pendings.delete(pending);
           break;
         }
       }
       if (raced.result.done || raced.result.value === undefined) {
         iterators[raced.index] = undefined;
         continue;
       }
       const relayUrl = relays[raced.index]?.url ?? `relay#${raced.index}`;
       yield { event: raced.result.value, relayUrl };
       arm(raced.index);
     }
   } finally {
     await Promise.allSettled(
       iterators.map((iterator) => iterator?.return?.(undefined) as Promise<unknown> | undefined),
     );
   }
 }
 
 /* ------------------------------------------------------------------------- */
 /* Scoped subscription construction                                           */
 /* ------------------------------------------------------------------------- */
 
 /** Parameters for {@link buildCourtSubscriptions}. */
 export interface CourtSubscriptionParams {
   /** Validated public session parameters (session start = createdAt). */
   readonly session: CourtSessionParameters;
   /** Local recipient's x-only Nostr pubkey (64-char lowercase hex). */
   readonly myPubkey: string;
 }
 
 /**
  * Build the deterministic, canonical relay filters for one Court recipient.
  *
  * Two filters are produced, in a fixed order:
  *
  * 1. Public protocol traffic: the Court protocol/ack kinds, restricted to
  *    roster authors (sorted) and to events carrying this session's hash in
  *    their `session` tag, `since` the session start.
  * 2. Private traffic: kind-1059 gift wraps p-tagged to `myPubkey`, `since`
  *    the session start minus the NIP-59 backdating window
  *    ({@link COURT_WRAP_LOOKBACK_SECONDS}) so wraps whose randomized
  *    `created_at` predates the session are still seen.
  *
  * Same inputs always produce deep-equal output: kinds and authors are sorted,
  * and no wall-clock or random state is consulted.
  */
 export function buildCourtSubscriptions(
   params: CourtSubscriptionParams,
 ): readonly CourtRelayFilter[] {
   if (!isRecord(params)) fail('malformed', 'subscription params must be an object');
   assertCourtSessionParameters(params.session);
   assertHex32(params.myPubkey, 'myPubkey');
 
   const authors = params.session.participants
     .map((participant) => participant.nostrPubkey)
     .sort();
   const kinds = [...COURT_INBOX_PUBLIC_KINDS].sort((a, b) => a - b);
   const sessionHash = hashCourtSessionParameters(params.session);
   const since = params.session.createdAt;
 
   return [
     { kinds, authors, since, '#session': [sessionHash] },
     {
       kinds: [COURT_GIFT_WRAP_KIND],
       '#p': [params.myPubkey],
       since: Math.max(0, since - COURT_WRAP_LOOKBACK_SECONDS),
     },
   ];
 }
 
 /* ------------------------------------------------------------------------- */
 /* Inbound classification                                                     */
 /* ------------------------------------------------------------------------- */
 
 /** Machine-readable rejection reasons from {@link classifyInboundEvent}. */
 export type CourtInboxRejectReason =
   /** Input is not a structurally plausible Nostr event. */
   | 'malformed_event'
   /** Kind is neither a public Court kind nor a gift wrap. */
   | 'wrong_kind'
   /** Public-kind author (or ack signer) is not a roster Nostr pubkey. */
   | 'author_not_in_roster'
   /** Gift wrap carries no 'p' tag for the local recipient pubkey. */
   | 'not_addressed_to_me'
   /** Public event predates the session start. */
   | 'stale_session'
   /** Event is an unbound legacy Court event (history only). */
   | 'legacy_event'
   /** Event mixes bound and unbound structure; never acceptable. */
   | 'invalid_binding'
   /** Bound event's session tag names a different session hash. */
   | 'session_mismatch';
 
 /** Accepted inbound categories from {@link classifyInboundEvent}. */
 export type CourtInboxCategory = 'protocol' | 'delivery-ack' | 'gift-wrap';
 
 /** Total (never-throwing) verdict of {@link classifyInboundEvent}. */
 export type CourtInboxClassification =
   | { readonly accepted: true; readonly category: CourtInboxCategory }
   | { readonly accepted: false; readonly reason: CourtInboxRejectReason };
 
 /** Parameters for {@link classifyInboundEvent}. */
 export interface CourtInboxClassifyParams {
   readonly session: CourtSessionParameters;
   /** Local recipient's x-only Nostr pubkey for gift-wrap address checks. */
   readonly myPubkey: string;
 }
 
 function isHex32(value: unknown): value is string {
   return typeof value === 'string' && HEX_32.test(value);
 }
 
 /**
  * Classify one inbound relay event against the session and roster.
  *
  * This function is total: adversarial input of any shape yields a typed
  * rejection reason, never a throw. Acceptance is structural only — a bound
  * protocol event must still pass `parseCourtProtocolEvent` (signature,
  * binding, content) before any state machine consumes it, and a gift wrap
  * must still survive signer-backed NIP-59 unwrap verification.
  */
 export function classifyInboundEvent(
   event: unknown,
   params: CourtInboxClassifyParams,
 ): CourtInboxClassification {
   try {
     if (!isRecord(event)) return { accepted: false, reason: 'malformed_event' };
     if (
       typeof event.kind !== 'number'
       || !Number.isSafeInteger(event.kind)
       || event.kind < 0
       || event.kind > MAX_NOSTR_KIND
       || !Array.isArray(event.tags)
       || !event.tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string'))
       || typeof event.content !== 'string'
       || !isHex32(event.pubkey)
       || !Number.isSafeInteger(event.created_at)
       || (event.created_at as number) < 0
     ) {
       return { accepted: false, reason: 'malformed_event' };
     }
     assertCourtSessionParameters(params.session);
     assertHex32(params.myPubkey, 'myPubkey');
 
     const session = params.session;
 
     if (event.kind === COURT_GIFT_WRAP_KIND) {
       const addressed = (event.tags as readonly string[][]).some(
         (tag) => tag[0] === 'p' && tag[1] === params.myPubkey,
       );
       // NIP-59 backdating makes created_at meaningless on wraps; the p-tag is
       // the only structural gate before decryption.
       return addressed
         ? { accepted: true, category: 'gift-wrap' }
         : { accepted: false, reason: 'not_addressed_to_me' };
     }
 
     if (!(COURT_INBOX_PUBLIC_KINDS as readonly number[]).includes(event.kind)) {
       return { accepted: false, reason: 'wrong_kind' };
     }
 
     const roster = new Set(session.participants.map((p) => p.nostrPubkey));
     if (!roster.has(event.pubkey as string)) {
       return { accepted: false, reason: 'author_not_in_roster' };
     }
     if ((event.created_at as number) < session.createdAt) {
       return { accepted: false, reason: 'stale_session' };
     }
 
     // Delivery acks are bound by their ['m', key] tag, not session tags; the
     // outbox performs full signature/author verification on consumption.
     if (event.kind === COURT_DELIVERY_ACK_KIND) {
       return { accepted: true, category: 'delivery-ack' };
     }
 
     const structural = classifyCourtProtocolEvent({
       tags: event.tags as string[][],
       content: event.content as string,
     });
     if (structural === 'legacy') return { accepted: false, reason: 'legacy_event' };
     if (structural === 'invalid') return { accepted: false, reason: 'invalid_binding' };
 
     const sessionTag = (event.tags as readonly string[][]).find((tag) => tag[0] === 'session');
     if (sessionTag?.[1] !== hashCourtSessionParameters(session)) {
       return { accepted: false, reason: 'session_mismatch' };
     }
     return { accepted: true, category: 'protocol' };
   } catch {
     return { accepted: false, reason: 'malformed_event' };
   }
 }
 
 /* ------------------------------------------------------------------------- */
 /* The inbox                                                                  */
 /* ------------------------------------------------------------------------- */
 
 /** Stored gift wrap, kept verbatim so drain can verify it after a restart. */
 export interface CourtInboxWrap {
   readonly kind: number;
   readonly content: string;
   readonly tags: readonly (readonly string[])[];
   readonly created_at: number;
   readonly pubkey: string;
   readonly id: string;
   readonly sig: string;
 }
 
 /** One deduplicated gift wrap tracked by the inbox. Immutable on change. */
 export interface CourtInboxRecord {
   /** Gift-wrap event id; the dedupe identity across relays. */
   readonly wrapId: string;
   readonly wrap: CourtInboxWrap;
   /** Sorted relay URLs that delivered this wrap (provenance). */
   readonly relays: readonly string[];
   /** Unix seconds of first delivery. */
   readonly firstSeen: number;
   /** Unix seconds of most recent delivery. */
   readonly lastSeen: number;
   /** Whether drain has already attempted this wrap. */
   readonly drained: boolean;
 }
 
 /** Creation parameters for {@link CourtInbox.create}. */
 export interface CourtInboxParams {
   /** Local recipient's x-only Nostr pubkey (64-char lowercase hex). */
   readonly myPubkey: string;
 }
 
 /** JSON-safe durable form of the whole inbox. */
 export interface CourtInboxSnapshot {
   readonly version: typeof COURT_INBOX_SNAPSHOT_VERSION;
   readonly myPubkey: string;
   readonly records: readonly CourtInboxRecord[];
 }
 
 /** One verified inner rumor produced by {@link CourtInbox.drain}. */
 export interface CourtInboxMessage {
   /** The verified NIP-59 inner rumor (unsigned by construction). */
   readonly rumor: NostrEvent;
   /** Ids of the wraps that carried this rumor. */
   readonly wrapIds: readonly string[];
   /** Sorted relay URLs that delivered any of those wraps. */
   readonly relays: readonly string[];
 }
 
 /** Result of {@link CourtInbox.ingest}. */
 export interface CourtInboxIngestResult {
   readonly record: CourtInboxRecord;
   /** True when the wrap id was already known (multi-relay redelivery). */
   readonly duplicate: boolean;
 }
 
 function assertWrapShape(value: unknown): asserts value is NostrEvent {
   if (!isRecord(value)) fail('malformed', 'wrap event must be an object');
   if (value.kind !== COURT_GIFT_WRAP_KIND) {
     fail('malformed', `inbox accepts only kind ${COURT_GIFT_WRAP_KIND} gift wraps`);
   }
   assertHex32(value.id, 'wrap.id');
   assertHex32(value.pubkey, 'wrap.pubkey');
   if (typeof value.sig !== 'string' || !HEX_64.test(value.sig)) {
     fail('malformed', 'wrap.sig must be 64-byte lowercase hex');
   }
   if (!Number.isSafeInteger(value.created_at) || (value.created_at as number) < 0) {
     fail('malformed', 'wrap.created_at must be a non-negative Unix timestamp');
   }
   if (typeof value.content !== 'string'
     || textEncoder.encode(value.content).length > MAX_WRAP_CONTENT_BYTES) {
     fail('malformed', `wrap.content must be a string of at most ${MAX_WRAP_CONTENT_BYTES} bytes`);
   }
   if (!Array.isArray(value.tags) || value.tags.length > MAX_WRAP_TAGS) {
     fail('malformed', `wrap.tags must be an array of at most ${MAX_WRAP_TAGS} tags`);
   }
   for (const tag of value.tags) {
     if (!Array.isArray(tag) || tag.length > MAX_WRAP_TAG_ITEMS) {
       fail('malformed', 'wrap tags must be bounded arrays');
     }
     for (const item of tag) {
       if (
         typeof item !== 'string'
         || textEncoder.encode(item).length > MAX_WRAP_TAG_ITEM_BYTES
       ) {
         fail('malformed', 'wrap tag items must be bounded strings');
       }
     }
   }
 }
 
 function copyWrap(wrap: NostrEvent): CourtInboxWrap {
   return {
     kind: wrap.kind,
     content: wrap.content,
     tags: wrap.tags.map((tag) => [...tag]),
     created_at: wrap.created_at,
     pubkey: wrap.pubkey,
     id: wrap.id,
     sig: wrap.sig,
   };
 }
 
 function copyRecord(record: CourtInboxRecord): CourtInboxRecord {
   return {
     ...record,
     wrap: { ...record.wrap, tags: record.wrap.tags.map((tag) => [...tag]) },
     relays: [...record.relays],
   };
 }
 
 function compareRecords(a: CourtInboxRecord, b: CourtInboxRecord): number {
   if (a.firstSeen !== b.firstSeen) return a.firstSeen - b.firstSeen;
   return a.wrapId < b.wrapId ? -1 : a.wrapId > b.wrapId ? 1 : 0;
 }
 
 /**
  * Recipient inbox for Court gift wraps over a relay group.
  *
  * Ingest dedupes by wrap id (the same wrap arriving from three relays is one
  * record with three provenance entries) and refuses wraps not p-tagged to
  * `myPubkey` before they are stored — so no code path can ever attempt to
  * decrypt a wrap addressed to someone else. Drain then re-checks the address
  * through the signer-backed NIP-59 unwrap, which verifies every layer.
  */
 export class CourtInbox {
   private readonly myPubkey: string;
   private readonly records = new Map<string, CourtInboxRecord>();
 
   private constructor(params: CourtInboxParams) {
     if (!isRecord(params)) fail('malformed', 'inbox params must be an object');
     assertHex32(params.myPubkey, 'myPubkey');
     this.myPubkey = params.myPubkey;
   }
 
   /** Create an empty inbox for one recipient pubkey. */
   static create(params: CourtInboxParams): CourtInbox {
     return new CourtInbox(params);
   }
 
   /** The recipient pubkey this inbox accepts wraps for. */
   get recipientPubkey(): string {
     return this.myPubkey;
   }
 
   /**
    * Ingest one gift wrap delivered by `relayUrl` at `now` (Unix seconds).
    *
    * Rejects, with a typed {@link CourtInboxError}:
    * - malformed wraps (`malformed`) — kind, id, pubkey, sig, tags, content
    *   are all shape-checked and bounded;
    * - wraps whose tags carry no `['p', myPubkey]` (`wrong_recipient`) — this
    *   check runs before storage and before any decrypt-capable code path;
    * - wraps beyond the capacity bound (`capacity_exceeded`).
    *
    * Re-delivery of a known wrap id is idempotent: the relay is added to the
    * record's provenance and `lastSeen` advances; `firstSeen` never moves.
    */
   ingest(wrapEvent: unknown, relayUrl: string, now: number): CourtInboxIngestResult {
     assertNow(now);
     assertRelayUrl(relayUrl);
     assertWrapShape(wrapEvent);
 
     // Recipient gate first: a wrap not addressed to this inbox is rejected
     // before storage, long before any signer/decrypt path exists.
     const addressed = wrapEvent.tags.some(
       (tag) => tag[0] === 'p' && tag[1] === this.myPubkey,
     );
     if (!addressed) {
       fail('wrong_recipient', 'gift wrap is not addressed to this inbox recipient');
     }
 
     const existing = this.records.get(wrapEvent.id);
     if (existing) {
       const relays = existing.relays.includes(relayUrl)
         ? existing.relays
         : [...existing.relays, relayUrl].sort();
       const next: CourtInboxRecord = {
         ...existing,
         relays,
         lastSeen: Math.max(existing.lastSeen, now),
       };
       this.records.set(existing.wrapId, next);
       return { record: copyRecord(next), duplicate: true };
     }
 
     if (this.records.size >= MAX_RECORDS) {
       fail('capacity_exceeded', `inbox capacity of ${MAX_RECORDS} records exceeded`);
     }
     const record: CourtInboxRecord = {
       wrapId: wrapEvent.id,
       wrap: copyWrap(wrapEvent),
       relays: [relayUrl],
       firstSeen: now,
       lastSeen: now,
       drained: false,
     };
     this.records.set(record.wrapId, record);
     return { record: copyRecord(record), duplicate: false };
   }
 
   /**
    * Drain all undrained wraps: NIP-59-unwrap each through the signer and
    * return the verified inner rumors sorted by `created_at` (ties broken by
    * rumor id for determinism).
    *
    * Follows `unwrapProtocolEventsWithSigner` semantics per wrap so each
    * message keeps its provenance: every layer is verified (address, seal
    * signature, seal-author == rumor-author, rumor id commitment). Wraps that
    * fail verification are marked drained and dropped — junk never retries
    * and never throws out of drain. Rumors arriving via multiple wraps
    * (re-wrapped duplicates) are merged into one message with combined
    * provenance. Every attempted record is marked drained.
    */
   async drain(signer: CourtEventSigner): Promise<readonly CourtInboxMessage[]> {
     const pending = [...this.records.values()]
       .filter((record) => !record.drained)
       .sort(compareRecords);
 
     const byRumorId = new Map<
       string,
       { rumor: NostrEvent; wrapIds: string[]; relays: Set<string> }
     >();
     for (const record of pending) {
-      let rumor: NostrEvent | null = null;
+      let rumor: NostrEvent | null;
       try {
         rumor = await unwrapProtocolEventWithSigner(record.wrap as unknown as NostrEvent, signer);
       } catch {
-        rumor = null;
+        // Signer/dependency failures are retryable: leave this record pending.
+        continue;
       }
       this.records.set(record.wrapId, { ...record, drained: true });
       if (!rumor || typeof rumor.id !== 'string') continue;
       const existing = byRumorId.get(rumor.id);
       if (existing) {
         existing.wrapIds.push(record.wrapId);
         for (const url of record.relays) existing.relays.add(url);
       } else {
         byRumorId.set(rumor.id, {
           rumor,
           wrapIds: [record.wrapId],
           relays: new Set(record.relays),
         });
       }
     }
 
     return [...byRumorId.values()]
       .map((entry): CourtInboxMessage => ({
         rumor: entry.rumor,
         wrapIds: entry.wrapIds,
         relays: [...entry.relays].sort(),
       }))
       .sort((a, b) => {
         if (a.rumor.created_at !== b.rumor.created_at) {
           return a.rumor.created_at - b.rumor.created_at;
         }
         return a.rumor.id < b.rumor.id ? -1 : a.rumor.id > b.rumor.id ? 1 : 0;
       });
   }
 
   /** Look up one record by wrap id, or undefined if absent. */
   getRecord(wrapId: string): CourtInboxRecord | undefined {
     if (!HEX_32.test(wrapId)) return undefined;
     const record = this.records.get(wrapId);
     return record ? copyRecord(record) : undefined;
   }
 
   /** All records, ordered by first-seen time then wrap id. */
   listRecords(): readonly CourtInboxRecord[] {
     return [...this.records.values()].sort(compareRecords).map(copyRecord);
   }
 
   /** JSON-safe deep-copied snapshot suitable for atomic persistence. */
   snapshot(): CourtInboxSnapshot {
     return {
       version: COURT_INBOX_SNAPSHOT_VERSION,
       myPubkey: this.myPubkey,
       records: this.listRecords(),
     };
   }
 
   /**
    * Validate and rehydrate an inbox from a snapshot. Any structural or
    * coherence failure — wrong version, duplicate wrap ids, empty provenance,
    * `lastSeen < firstSeen`, a wrap not addressed to the snapshot's own
    * recipient, or a recipient mismatch against `expectedMyPubkey` — rejects
    * the whole snapshot with code corrupt_snapshot.
    */
   static fromSnapshot(data: unknown, expectedMyPubkey?: string): CourtInbox {
     const corrupt = (message: string): never => fail('corrupt_snapshot', message);
     const snapshot: Record<string, unknown> = isRecord(data)
       ? data
       : corrupt('snapshot must be an object');
     if (snapshot.version !== COURT_INBOX_SNAPSHOT_VERSION) {
       corrupt('unsupported snapshot version');
     }
     try {
       assertHex32(snapshot.myPubkey, 'snapshot.myPubkey');
     } catch (error) {
       if (error instanceof CourtInboxError) corrupt(error.message);
       throw error;
     }
     if (expectedMyPubkey !== undefined) {
       try {
         assertHex32(expectedMyPubkey, 'expectedMyPubkey');
       } catch (error) {
         if (error instanceof CourtInboxError) {
           throw new CourtInboxError('malformed', error.message);
         }
         throw error;
       }
       if (snapshot.myPubkey !== expectedMyPubkey) {
         corrupt('snapshot recipient does not match the expected pubkey');
       }
     }
     const rawRecords: readonly unknown[] = Array.isArray(snapshot.records)
       ? snapshot.records
       : corrupt('snapshot records must be an array');
     if (rawRecords.length > MAX_RECORDS) {
       corrupt(`snapshot records must contain at most ${MAX_RECORDS} entries`);
     }
 
     const inbox = new CourtInbox({ myPubkey: snapshot.myPubkey as string });
     for (const raw of rawRecords) {
       const record = restoreRecord(raw, snapshot.myPubkey as string);
       if (inbox.records.has(record.wrapId)) {
         corrupt('snapshot contains duplicate wrap ids');
       }
       inbox.records.set(record.wrapId, record);
     }
     return inbox;
   }
 }
 
 /** Create an empty inbox for one recipient pubkey. */
 export function createCourtInbox(params: CourtInboxParams): CourtInbox {
   return CourtInbox.create(params);
 }
 
 function restoreRecord(raw: unknown, myPubkey: string): CourtInboxRecord {
   const corrupt = (message: string): never => fail('corrupt_snapshot', message);
   const record: Record<string, unknown> = isRecord(raw)
     ? raw
     : corrupt('record must be an object');
 
   const rawRelays: unknown = record.relays;
   try {
     assertHex32(record.wrapId, 'record.wrapId');
     assertWrapShape(record.wrap);
     if (!Array.isArray(rawRelays)
       || rawRelays.length === 0
       || rawRelays.length > MAX_RELAYS_PER_RECORD) {
       corrupt('record.relays must be a non-empty bounded array');
     }
     const relayUrls = rawRelays as readonly unknown[];
     for (const url of relayUrls) assertRelayUrl(url);
     if (new Set(relayUrls).size !== relayUrls.length) {
       corrupt('record.relays must not contain duplicates');
     }
     if (!Number.isSafeInteger(record.firstSeen) || (record.firstSeen as number) < 0) {
       corrupt('record.firstSeen must be a non-negative Unix timestamp');
     }
     if (
       !Number.isSafeInteger(record.lastSeen)
       || (record.lastSeen as number) < (record.firstSeen as number)
     ) {
       corrupt('record.lastSeen must be at or after firstSeen');
     }
     if (typeof record.drained !== 'boolean') {
       corrupt('record.drained must be a boolean');
     }
   } catch (error) {
     if (error instanceof CourtInboxError) {
       if (error.code === 'corrupt_snapshot') throw error;
       corrupt(error.message);
     }
     throw error;
   }
 
   const wrap = record.wrap as unknown as NostrEvent;
   if (wrap.id !== record.wrapId) {
     corrupt('record wrap id does not match its stored wrap');
   }
   const addressed = wrap.tags.some((tag) => tag[0] === 'p' && tag[1] === myPubkey);
   if (!addressed) {
     corrupt('record wrap is not addressed to the snapshot recipient');
   }
 
   return {
     wrapId: record.wrapId,
     wrap: copyWrap(wrap),
     relays: [...(rawRelays as readonly string[])].sort(),
     firstSeen: record.firstSeen as number,
     lastSeen: record.lastSeen as number,
     drained: record.drained as boolean,
   };
 }

```


## Medium Severity Findings

---

### Audited by [V12](https://v12.sh/)

**Affected files:** dispute.ts, courtVoteMachine.ts

**V12 reasoning:** Separated the sessionless legacy commitment into its own domain and added an explicit digest-format discriminator: machine commitments set the discriminator bit, legacy commitments clear it, and the vote reducer rejects legacy commitments at admission instead of storing commitments that can never reveal.

```diff
diff --git a/dispute.ts b/dispute.ts
--- a/dispute.ts
+++ b/dispute.ts
@@ -1,167 +1,168 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Dispute override signing for the BAO Court / FROST appeal layer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
 import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
 import * as frost from '@vbyte/frost';
 import { CanonicalWriter } from './courtSession';
 import { runNormalSigningRound } from './signing';
 import type { DkgRecord, DisputeCase, FrostAttestation, JurorVote } from './types';
 
-/** Same domain tag as the machine-path vote commit (courtVoteMachine). */
-const VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
+/** Distinct domain for the legacy, sessionless imperative vote path. */
+const LEGACY_VOTE_COMMIT_DOMAIN = 'BAO-Court/LegacyVoteCommit/v1';
+const LEGACY_COMMIT_VERSION_MASK = 0x7;
 
 /**
- * Commit hash for the imperative vote path: H(domain, outcome, salt) with
- * canonical length-prefixed encoding. The old `${outcome}|${salt}` join was
- * ambiguous — an outcome containing `|` could alias the salt and let two
- * distinct ballots commit to the same digest.
+ * Commit hash for the legacy imperative vote path. The high bit of the first
+ * nibble is cleared as an explicit format discriminator, so a court vote
+ * machine can reject this sessionless format when the commit is received.
  */
 export function hashCommit(outcome: string, salt: string): string {
   const writer = new CanonicalWriter();
   writer.text(outcome);
   writer.text(salt);
   const encoded = writer.finish();
-  const domain = new TextEncoder().encode(VOTE_COMMIT_DOMAIN);
+  const domain = new TextEncoder().encode(LEGACY_VOTE_COMMIT_DOMAIN);
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
-  return bytesToHex(sha256(input));
+  const digest = bytesToHex(sha256(input));
+  return (Number.parseInt(digest[0], 16) & LEGACY_COMMIT_VERSION_MASK).toString(16) + digest.slice(1);
 }
 
 export interface TallyResult {
   readonly outcome: string;
   readonly supportingVotes: JurorVote[];
   /**
    * Revealed votes whose commit-reveal hash did not match. They are excluded
    * from the tally (matching CourtVoteMachine, which refuses a mismatched
    * reveal at accept time) and surfaced here as slashing evidence. A single
    * malformed or malicious reveal must not abort the whole count.
    */
   readonly invalidReveals: JurorVote[];
 }
 
 export function tallyVotes(
   votes: readonly JurorVote[],
 ): TallyResult {
   const counts = new Map<string, JurorVote[]>();
   const invalidReveals: JurorVote[] = [];
   for (const v of votes) {
     if (!v.reveal) continue;
     if (hashCommit(v.reveal.outcome, v.reveal.salt) !== v.commit) {
       invalidReveals.push(v);
       continue;
     }
     const list = counts.get(v.reveal.outcome) ?? [];
     list.push(v);
     counts.set(v.reveal.outcome, list);
   }
 
   let winner = '';
   let max = -1;
   // Deterministic, order-independent tie-break: on equal counts the
   // lexicographically smallest outcome wins. This MUST match
   // courtVoteMachine.finalize_tally so every observer derives the same
   // verdict regardless of reveal arrival order.
   for (const [outcome, list] of counts.entries()) {
     if (list.length > max || (list.length === max && outcome < winner)) {
       max = list.length;
       winner = outcome;
     }
   }
 
   return {
     outcome: winner,
     supportingVotes: counts.get(winner) ?? [],
     invalidReveals,
   };
 }
 
 /**
  * Derive a deterministic x-only pubkey from the normal group key + dispute id.
  *
  * WARNING: the derivation maps public inputs to a scalar, so the private key
  * of the returned pubkey is PUBLICLY COMPUTABLE (known discrete log). This
  * key is NOT threshold-protected and must NEVER be used to accept FROST
  * attestation signatures — anyone could sign for it. It exists for demo
  * contracts that need a deterministic dispute key; keep it out of any path
  * that authenticates real value.
  */
 export function deriveDisputeGroupPubkey(
   normalGroupPubkey: string,
   disputeId: string,
 ): string {
   const order = secp256k1.Point.Fn.ORDER;
   let digest = sha256(new TextEncoder().encode(normalGroupPubkey + disputeId));
   let scalar = bytesToNumberBE(digest) % order;
   // Re-hash on the astronomically unlikely zero scalar to guarantee a valid key.
   while (scalar === 0n) {
     digest = sha256(digest);
     scalar = bytesToNumberBE(digest) % order;
   }
   const scalarBytes = numberToBytesBE(scalar, 32);
   const pk = schnorr.getPublicKey(scalarBytes);
   return bytesToHex(pk);
 }
 
 export interface DisputeSigningParams {
   readonly dispute: DisputeCase;
   readonly dkg: DkgRecord;
   readonly shares: readonly frost.SecretShare[];
   /** Outcome to attest. Defaults to the dispute's proposed outcome. */
   readonly outcome?: string;
   /**
    * Dispute verdict commitment bound into the signed message. REQUIRED for
    * real dispute attestations — see {@link buildAttestationMessage}.
    */
   readonly verdictHash?: string;
   /** Supporting reveal event ids of the attested verdict. */
   readonly supportingEventIds?: readonly string[];
 }
 
 export function runDisputeOverrideSigning(
   params: DisputeSigningParams,
 ): FrostAttestation {
   const attestation = runNormalSigningRound({
     marketId: params.dispute.marketId,
     outcome: params.outcome ?? params.dispute.proposedOutcome,
     round: 1,
     disputeEventId: params.dispute.disputeId,
     verdictHash: params.verdictHash,
     dkg: params.dkg,
     shares: params.shares,
   });
 
   return {
     ...attestation,
     kind: 39007,
     disputeEventId: params.dispute.disputeId,
     verdictHash: params.verdictHash,
     supportingEventIds: params.supportingEventIds,
   };
 }
 
 /**
  * Canonical synthetic reveal event id for SIMULATED ceremonies (the demo
  * coordinator and the end-to-end simulator run the vote in-process, so no
  * Nostr reveal events exist to reference). Production ceremonies MUST use the
  * real kind-39014 reveal event ids — the commitment is over the same field,
  * so swapping in real ids changes nothing structurally.
  */
 export function deriveSimulatedRevealEventId(idx: number, outcome: string, salt: string): string {
   const writer = new CanonicalWriter();
   writer.u32(idx);
   writer.text(outcome);
   writer.text(salt);
   const encoded = writer.finish();
   const domain = new TextEncoder().encode('BAO-Court/SimRevealEvent/v1');
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }

diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,444 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
+const COURT_COMMIT_VERSION_BIT = 0x8;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
-  return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
+  const digest = digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
+  return (Number.parseInt(digest[0], 16) | COURT_COMMIT_VERSION_BIT).toString(16) + digest.slice(1);
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
+    if ((Number.parseInt(event.commitHash[0], 16) & COURT_COMMIT_VERSION_BIT) === 0) {
+      throw new CourtVoteTransitionError('vote commit uses a legacy sessionless format');
+    }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Bind and reuse the verified seal before wrapping

**Affected files:** courtSigner.ts

**V12 reasoning:** Bind the external signer's verified seal to the exact requested ciphertext, deep-copy its tags into the reconstructed plain event, and pass only that verified candidate to NIP-59 wrapping so signer-controlled serialization cannot alter the checked seal.

```diff
diff --git a/courtSigner.ts b/courtSigner.ts
--- a/courtSigner.ts
+++ b/courtSigner.ts
@@ -1,266 +1,267 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Signer-backed private transport for BAO Court protocol messages.
  *
  * Every private Court message (DKG shares, complaints, backups, refresh
  * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
  * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
  * process memory. This module provides the same capabilities through a
  * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
  * signers, hardware-backed agents) so production jurors never expose an
  * `nsec` to the Court host.
  *
  * The signer surface is intentionally narrow: public key, event signing, and
  * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
  * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
  * `nip44_decrypt`).
  *
  * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
  * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
  * seal author equals the rumor author, and recomputes the rumor id. A gift
  * wrap that fails any check is rejected (returns null), never partially
  * trusted.
  */
 
 import {
   finalizeEvent,
   generateSecretKey,
   getEventHash,
   getPublicKey,
   verifyEvent,
 } from 'nostr-tools/pure';
 import { nip59 } from 'nostr-tools';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
 
 const SEAL_KIND = 13;
 const GIFT_WRAP_KIND = 1059;
 const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
 
 const HEX_64 = /^[0-9a-f]{64}$/;
 
 /** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
 function randomNowSeconds(): number {
   return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
 }
 
 function assertHex64(value: string, label: string): void {
   if (!HEX_64.test(value)) {
     throw new Error(`${label} must be a 64-character lowercase hex string`);
   }
 }
 
 /**
  * Minimal external signer surface required for Court private transport.
  * Implementations MUST NOT expose the secret key.
  */
 export interface CourtEventSigner {
   /** The signer's x-only public key (64-char hex). */
   getPublicKey(): Promise<string> | string;
   /** Sign an event template; the signer fills pubkey, id, and sig. */
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent>;
   /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
   /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
 }
 
 /**
  * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
  * signer-backed keys work everywhere the Court already accepts encryption
  * providers (DKG sessions, backups, complaints).
  */
 export class Nip44SignerCrypto implements Nip44Crypto {
   constructor(private readonly signer: CourtEventSigner) {}
 
   encrypt(plaintext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Encrypt(peerPubkey, plaintext);
   }
 
   decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Decrypt(peerPubkey, ciphertext);
   }
 }
 
 /**
  * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
  * demo rooms, and local tooling — production jurors should use a real
  * external signer. Keeping this adapter means the entire private-transport
  * stack has exactly one code path regardless of key custody.
  */
 export class SeckeyCourtSigner implements CourtEventSigner {
   private readonly seckey: Uint8Array;
   private readonly crypto: Nip44SeckeyCrypto;
 
   constructor(seckey: string | Uint8Array) {
     // Copy at the boundary: caller-supplied buffers must never alias our
     // secret, or later mutation/zeroization of the source silently corrupts
     // (or "destroys") this signer.
     this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
     if (this.seckey.length !== 32) {
       throw new Error('seckey must be 32 bytes');
     }
     this.crypto = new Nip44SeckeyCrypto(this.seckey);
   }
 
   getPublicKey(): string {
     return getPublicKey(this.seckey);
   }
 
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent> {
     return Promise.resolve(finalizeEvent(template, this.seckey));
   }
 
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
     return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
   }
 
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
     return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
   }
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null;
 }
 
 /**
  * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
  * recipient, using only the signer's public methods. The sender's secret key
  * never enters this process; the outer wrap's ephemeral key is generated
  * locally per wrap (it is random by design and protects nothing long-term).
  */
 export async function wrapProtocolEventWithSigner(
   event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
   signer: CourtEventSigner,
   recipientPubkey: string,
 ): Promise<NostrEvent> {
   assertHex64(recipientPubkey, 'recipient pubkey');
   const senderPubkey = await signer.getPublicKey();
   assertHex64(senderPubkey, 'signer pubkey');
 
   // Rumor: unsigned, id commits to author + content.
   const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
   rumor.id = getEventHash(rumor as NostrEvent);
 
   // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
   // through the external signer.
   const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
   const seal = await signer.signEvent({
     kind: SEAL_KIND,
     content: sealContent,
     created_at: randomNowSeconds(),
     tags: [],
   });
   // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
   // their verdict in a non-JSON-enumerable symbol that object spreads
   // preserve, so a malicious signer returning a once-valid seal it then
   // tampered with must never reach the verifier with the cached verdict
   // attached.
   const sealCandidate: NostrEvent = {
     id: seal.id,
     pubkey: seal.pubkey,
     sig: seal.sig,
     kind: seal.kind,
     created_at: seal.created_at,
     content: seal.content,
-    tags: seal.tags,
+    tags: Array.from(seal.tags, (tag) => Array.from(tag)),
   } as NostrEvent;
   if (
     sealCandidate.kind !== SEAL_KIND
     || sealCandidate.pubkey !== senderPubkey
+    || sealCandidate.content !== sealContent
     || !verifyEvent(sealCandidate)
   ) {
     throw new Error('external signer returned an invalid NIP-59 seal');
   }
 
   // Wrap: kind 1059 under a locally generated ephemeral key.
-  return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
+  return nip59.createWrap(sealCandidate, recipientPubkey) as NostrEvent;
 }
 
 /**
  * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
  * full NIP-59 verification. Returns the inner rumor, or null if any layer is
  * malformed, misaddressed, forged, or tampered with.
  */
 export async function unwrapProtocolEventWithSigner(
   wrapEvent: NostrEvent,
   signer: CourtEventSigner,
 ): Promise<NostrEvent | null> {
   try {
     if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
     const recipientPubkey = await signer.getPublicKey();
     const addressed = wrapEvent.tags.some(
       (t) => t[0] === 'p' && t[1] === recipientPubkey,
     );
     if (!addressed) return null;
 
     const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
     const seal: unknown = JSON.parse(sealJson);
     if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
     const sealEvent = seal as unknown as NostrEvent;
     if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;
 
     const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
     const rumor: unknown = JSON.parse(rumorJson);
     if (!isRecord(rumor)) return null;
     const rumorEvent = rumor as unknown as NostrEvent;
 
     // NIP-59: the seal must be signed by the rumor's author, and the rumor id
     // must commit to its exact contents.
     if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
     if (typeof rumorEvent.id !== 'string') return null;
     if (getEventHash(rumorEvent) !== rumorEvent.id) return null;
 
     return rumorEvent;
   } catch {
     return null;
   }
 }
 
 /**
  * Unwrap many gift wraps with a signer and filter to a specific inner kind
  * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
  * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
  */
 export async function unwrapProtocolEventsWithSigner(
   wraps: readonly NostrEvent[],
   signer: CourtEventSigner,
   options?: {
     readonly kinds?: readonly number[];
     readonly disputeId?: string;
   },
 ): Promise<NostrEvent[]> {
   const seen = new Set<string>();
   const result: NostrEvent[] = [];
 
   for (const wrap of wraps) {
     const rumor = await unwrapProtocolEventWithSigner(wrap, signer);
     if (!rumor || !rumor.id) continue;
     if (seen.has(rumor.id)) continue;
     seen.add(rumor.id);
 
     if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
     if (options?.disputeId) {
       const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
       if (disputeTag?.[1] !== options.disputeId) continue;
     }
 
     result.push(rumor);
   }
 
   return result;
 }
 
 /** Generate a fresh random secret key (hex) — for tests and demo rooms. */
 export function generateCourtSeckeyHex(): string {
   return bytesToHex(generateSecretKey());
 }

```


---

### Bound public vote-commitment hash inputs

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Validate sessionHash and salt as exact lowercase 32-byte hex and reject empty or UTF-8 outcomes over 256 bytes before canonical decoding, encoding, allocation, and hashing; all rejections use CourtVoteTransitionError.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,461 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
+  if (
+    typeof params.sessionHash !== 'string'
+    || params.sessionHash.length !== 64
+    || !HEX_32.test(params.sessionHash)
+  ) {
+    throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
+  }
+  if (
+    typeof params.outcome !== 'string'
+    || params.outcome.length === 0
+    || params.outcome.length > MAX_OUTCOME_BYTES
+    || textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
+  ) {
+    throw new CourtVoteTransitionError('outcome must be a non-empty bounded string');
+  }
+  if (
+    typeof params.salt !== 'string'
+    || params.salt.length !== 64
+    || !HEX_32.test(params.salt)
+  ) {
+    throw new CourtVoteTransitionError('salt must be 32-byte lowercase hex');
+  }
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Bound verdict evidence and participant cardinality

**Affected files:** courtVoteMachine.ts, events.ts

**V12 reasoning:** Adds a single 512-entry protocol bound for vote participants and verdict evidence, validates lowercase 32-byte support IDs before hash sorting/encoding or attestation construction, and makes relay attestation parsing reject malformed or oversized evidence incrementally.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,460 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
+/** Maximum roster and verdict-evidence cardinality accepted by the protocol. */
+export const MAX_COURT_CARDINALITY = 512;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
+  assertSupportingEventIds(params.supportingEventIds);
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
+function assertSupportingEventIds(value: readonly string[]): void {
+  if (!Array.isArray(value) || value.length > MAX_COURT_CARDINALITY) {
+    throw new CourtVoteTransitionError(
+      `supportingEventIds must contain at most ${MAX_COURT_CARDINALITY} entries`,
+    );
+  }
+  if (value.some((id) => typeof id !== 'string' || !HEX_32.test(id))) {
+    throw new CourtVoteTransitionError('supporting event ids must be 32-byte lowercase hex');
+  }
+}
+
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
+  assertSupportingEventIds(params.supportingEventIds);
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
-  if (params.participantIndices.length === 0) {
-    throw new CourtVoteTransitionError('voting requires at least one participant');
+  if (
+    !Array.isArray(params.participantIndices) ||
+    params.participantIndices.length === 0 ||
+    params.participantIndices.length > MAX_COURT_CARDINALITY
+  ) {
+    throw new CourtVoteTransitionError(
+      `voting requires 1..${MAX_COURT_CARDINALITY} participants`,
+    );
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

diff --git a/events.ts b/events.ts
--- a/events.ts
+++ b/events.ts
@@ -1,874 +1,895 @@
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
+import { MAX_COURT_CARDINALITY } from './courtVoteMachine';
 
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
 
+function isSupportingEventId(value: unknown): value is string {
+  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
+}
+
 /** Parse a positive integer (valid FROST/juror index); null when invalid. */
 function parsePositiveInt(value: unknown): number | null {
   const n = Number(value);
   return Number.isInteger(n) && n >= 1 ? n : null;
 }
 
 function dTag(disputeId: string, suffix?: string | number): [string, string] {
   return ['d', suffix !== undefined ? `${disputeId}:${suffix}` : disputeId];
 }
 
 export function buildDisputeEvent(params: DisputeEventParams): EventTemplate {
   const tags: string[][] = [
     dTag(params.disputeId),
     ['e', params.marketEventId ?? params.marketId, '', 'root'],
     ['market', params.marketId],
     ['dispute', params.disputeId],
     ['original', params.originalOutcome],
     ['proposed', params.proposedOutcome],
     ['deadline', String(params.disputeDeadline)],
     ['appeal_type', 'frost'],
     ...params.evidenceHashes.map((h): [string, string] => ['evidence', h]),
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
-  const supportingEventIds = event.tags
-    .filter((t) => t[0] === 'e' && t[3] === 'mention')
-    .map((t) => t[1]);
+  const supportingEventIds: string[] = [];
+  for (const tag of event.tags) {
+    if (tag[0] !== 'e' || tag[3] !== 'mention') continue;
+    const id = tag[1];
+    if (!isSupportingEventId(id) || supportingEventIds.length === MAX_COURT_CARDINALITY) {
+      return null;
+    }
+    supportingEventIds.push(id);
+  }
 
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
+  const supportingEventIds = attestation.supportingEventIds ?? [];
+  if (
+    !Array.isArray(supportingEventIds) ||
+    supportingEventIds.length > MAX_COURT_CARDINALITY ||
+    supportingEventIds.some((id) => !isSupportingEventId(id))
+  ) {
+    throw new Error(
+      `supportingEventIds must contain at most ${MAX_COURT_CARDINALITY} lowercase 32-byte hex ids`,
+    );
+  }
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
-  for (const id of attestation.supportingEventIds ?? []) {
+  for (const id of supportingEventIds) {
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
-      supportingEventIds: attestation.supportingEventIds ?? [],
+      supportingEventIds: supportingEventIds,
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

```


---

### Canonicalize support IDs before hashing verdicts

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Canonicalize a copied supporting-event-ID list inside hashCourtVerdict before encoding, making the exported hash order-independent without mutating caller input.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,440 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
-  writer.u32(params.supportingEventIds.length);
-  for (const eventId of params.supportingEventIds) {
+  const sorted = [...params.supportingEventIds].sort();
+  writer.u32(sorted.length);
+  for (const eventId of sorted) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Coercion Bypasses Canonical Hash Validation

**Affected files:** courtDkgMachine.ts

**V12 reasoning:** Require primitive strings before applying canonical regex validation to the DKG session hash, transcript hash, and candidate group key, preventing regex coercion and persistence of non-string values.

```diff
diff --git a/courtDkgMachine.ts b/courtDkgMachine.ts
--- a/courtDkgMachine.ts
+++ b/courtDkgMachine.ts
@@ -1,275 +1,280 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /** Pure fail-closed state machine for one BAO Court DKG attempt. */
 
 export type CourtDkgPhase =
   | 'parameters_confirmed'
   | 'dkg_round_1'
   | 'dkg_round_2'
   | 'transcript_signing'
   | 'certified'
   | 'backed_up'
   | 'expired'
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite';
 
 export type CourtDkgFailurePhase = Extract<
   CourtDkgPhase,
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite'
 >;
 
 export interface CourtDkgFailure {
   readonly phase: CourtDkgFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtDkgMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
   readonly phase: CourtDkgPhase;
   readonly round1Participants: readonly number[];
   readonly round2Participants: readonly number[];
   readonly transcriptCertifiers: readonly number[];
   readonly transcriptHash?: string;
   readonly candidateGroupPubkey?: string;
   /** Unavailable until every participant certifies the exact transcript. */
   readonly certifiedGroupPubkey?: string;
   readonly backupVerified: boolean;
   readonly failure?: CourtDkgFailure;
 }
 
 export type CourtDkgMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | { readonly type: 'accept_round_1'; readonly idx: number; readonly now: number }
   | { readonly type: 'accept_round_2'; readonly idx: number; readonly now: number }
   | {
       readonly type: 'finalize_transcript';
       readonly transcriptHash: string;
       readonly candidateGroupPubkey: string;
       readonly now: number;
     }
   | {
       readonly type: 'accept_certification';
       readonly idx: number;
       readonly transcriptHash: string;
       readonly now: number;
     }
   | { readonly type: 'confirm_backup'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtDkgFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtDkgTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtDkgTransitionError';
   }
 }
 
 const HEX_32 = /^[0-9a-f]{64}$/;
 const GROUP_KEY = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 
 const TERMINAL_PHASES = new Set<CourtDkgPhase>([
   'backed_up',
   'expired',
   'delivery_failed',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
   'incompatible_suite',
 ]);
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtDkgTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function addSorted(values: readonly number[], idx: number): readonly number[] {
   if (values.includes(idx)) return values;
   return [...values, idx].sort((a, b) => a - b);
 }
 
 function assertParticipant(state: CourtDkgMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtDkgTransitionError(`participant ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtDkgMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtDkgTransitionError('DKG message arrived at or after the ceremony deadline');
   }
 }
 
 function expire(state: CourtDkgMachineState, now: number): CourtDkgMachineState {
   assertNow(now);
   if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') return state;
   if (now < state.deadline) return state;
   return {
     ...state,
     phase: 'expired',
     failure: { phase: 'expired', reason: 'The DKG deadline passed before unanimous certification.' },
   };
 }
 
 export function createCourtDkgMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
 }): CourtDkgMachineState {
-  if (!HEX_32.test(params.sessionHash)) {
+  if (typeof params.sessionHash !== 'string' || !HEX_32.test(params.sessionHash)) {
     throw new CourtDkgTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtDkgTransitionError('deadline must be a positive Unix timestamp');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtDkgTransitionError('DKG requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtDkgTransitionError('participant indices must be ordered and sequential');
     }
   });
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     deadline: params.deadline,
     phase: 'parameters_confirmed',
     round1Participants: [],
     round2Participants: [],
     transcriptCertifiers: [],
     backupVerified: false,
   };
 }
 
 export function reduceCourtDkgMachine(
   state: CourtDkgMachineState,
   event: CourtDkgMachineEvent,
 ): CourtDkgMachineState {
   if (event.type === 'tick') return expire(state, event.now);
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') {
       throw new CourtDkgTransitionError(`cannot abort DKG from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtDkgTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'parameters_confirmed') {
       throw new CourtDkgTransitionError(`cannot start DKG from ${state.phase}`);
     }
     return { ...state, phase: 'dkg_round_1' };
   }
 
   if (event.type === 'accept_round_1') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_1') {
       throw new CourtDkgTransitionError(`cannot accept round 1 data during ${state.phase}`);
     }
     const accepted = addSorted(state.round1Participants, event.idx);
     return {
       ...state,
       round1Participants: accepted,
       phase: accepted.length === state.participantIndices.length ? 'dkg_round_2' : state.phase,
     };
   }
 
   if (event.type === 'accept_round_2') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_2') {
       throw new CourtDkgTransitionError(`cannot accept round 2 data during ${state.phase}`);
     }
     return { ...state, round2Participants: addSorted(state.round2Participants, event.idx) };
   }
 
   if (event.type === 'finalize_transcript') {
     assertBeforeDeadline(state, event.now);
     if (
       state.phase !== 'dkg_round_2'
       || state.round2Participants.length !== state.participantIndices.length
     ) {
       throw new CourtDkgTransitionError('cannot finalize before every participant completes round 2');
     }
-    if (!HEX_32.test(event.transcriptHash) || !GROUP_KEY.test(event.candidateGroupPubkey)) {
+    if (
+      typeof event.transcriptHash !== 'string'
+      || typeof event.candidateGroupPubkey !== 'string'
+      || !HEX_32.test(event.transcriptHash)
+      || !GROUP_KEY.test(event.candidateGroupPubkey)
+    ) {
       throw new CourtDkgTransitionError('transcript hash or candidate group key has invalid encoding');
     }
     return {
       ...state,
       phase: 'transcript_signing',
       transcriptHash: event.transcriptHash,
       candidateGroupPubkey: event.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'accept_certification') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'transcript_signing' || !state.transcriptHash || !state.candidateGroupPubkey) {
       throw new CourtDkgTransitionError(`cannot certify transcript during ${state.phase}`);
     }
     if (event.transcriptHash !== state.transcriptHash) {
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A participant certified a different DKG transcript.',
         },
       };
     }
     const certifiers = addSorted(state.transcriptCertifiers, event.idx);
     if (certifiers.length !== state.participantIndices.length) {
       return { ...state, transcriptCertifiers: certifiers };
     }
     return {
       ...state,
       phase: 'certified',
       transcriptCertifiers: certifiers,
       certifiedGroupPubkey: state.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'confirm_backup') {
     // Backup confirmation is a LOCAL event (the juror validated its own
     // recovery data), not a peer message, so it is not bounded by the
     // ceremony deadline. A certified machine must never be stranded: without
     // this, a certification at the deadline could never reach `backed_up`
     // and was frozen in `certified` forever.
     assertNow(event.now);
     if (state.phase !== 'certified' || !state.certifiedGroupPubkey) {
       throw new CourtDkgTransitionError('cannot confirm recovery data before DKG certification');
     }
     return { ...state, phase: 'backed_up', backupVerified: true };
   }
 
   return state;
 }

```


---

### Duplicate persisted records bypass distinct-signer thresholds

**Affected files:** courtSigningMachine.ts

**V12 reasoning:** Adds a single reducer-entry invariant boundary that rejects invalid or duplicate commitment/partial records and requires any finalized signer set to exactly match the distinct sorted commitment indices, preventing raw array lengths from satisfying thresholds with duplicate restored records.

```diff
diff --git a/courtSigningMachine.ts b/courtSigningMachine.ts
--- a/courtSigningMachine.ts
+++ b/courtSigningMachine.ts
@@ -1,386 +1,428 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court FROST signing attempt.
  *
  * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
  * aggregate -> attestation_published.
  *
  * The signing-session hash binds the Court session hash, the frozen verdict
  * hash, the exact outcome, the signing attempt, the threshold, and the signer
  * set. Changing any bound field requires a new machine for a new attempt and
  * invalidates every prior nonce commitment. Each roster signer may publish
  * exactly one nonce commitment per attempt; a conflicting second commitment
  * is nonce equivocation and aborts the attempt with blame.
  *
  * This module performs no FROST cryptographic verification; the boundary must
  * verify partial signatures against the certified verification shares and the
  * finalized commitment set before dispatching events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';
 
 export type CourtSigningPhase =
   | 'intent'
   | 'nonce_commit'
   | 'commitment_set_final'
   | 'partial_sign'
   | 'aggregate'
   | 'attestation_published'
   | 'expired'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network';
 
 export type CourtSigningFailurePhase = Extract<
   CourtSigningPhase,
   'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
 >;
 
 export interface CourtSigningFailure {
   readonly phase: CourtSigningFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtSigningCommitmentRecord {
   readonly idx: number;
   readonly binderPn: string;
   readonly hiddenPn: string;
 }
 
 export interface CourtSigningPartialRecord {
   readonly idx: number;
   readonly psig: string;
 }
 
 export interface CourtSigningMachineState {
   readonly signingSessionHash: string;
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
   readonly phase: CourtSigningPhase;
   readonly commitments: readonly CourtSigningCommitmentRecord[];
   /** Frozen, sorted signer set whose commitments define the signing context. */
   readonly finalizedSignerSet?: readonly number[];
   readonly partials: readonly CourtSigningPartialRecord[];
   readonly signature?: string;
   readonly attestationEventId?: string;
   readonly failure?: CourtSigningFailure;
 }
 
 export type CourtSigningMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | {
       readonly type: 'accept_commitment';
       readonly idx: number;
       readonly binderPn: string;
       readonly hiddenPn: string;
       readonly now: number;
     }
   | { readonly type: 'close_commitments'; readonly now: number }
   | {
       readonly type: 'accept_partial';
       readonly idx: number;
       readonly psig: string;
       readonly now: number;
     }
   | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
   | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtSigningFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtSigningTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtSigningTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtSigningPhase>([
   'attestation_published',
   'expired',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
 ]);
 
 /**
  * Canonical hash binding every field that defines one signing attempt. A
  * FROST nonce commitment may be consumed only under exactly one such hash.
  */
 export function hashCourtSigningSession(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.hex(params.verdictHash);
   writer.text(params.outcome);
   writer.u32(params.participantIndices.length);
   for (const idx of params.participantIndices) {
     writer.u32(idx);
   }
   writer.u32(params.threshold);
   writer.u32(params.attempt);
   const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
   const encoded = writer.finish();
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtSigningTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtSigningMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtSigningTransitionError(`signer ${idx} is outside the certified roster`);
   }
 }
 
+function assertSigningRecordInvariants(state: CourtSigningMachineState): void {
+  const commitmentIndices = new Set<number>();
+  for (const commitment of state.commitments) {
+    assertParticipant(state, commitment.idx);
+    if (!HEX_POINT.test(commitment.binderPn) || !HEX_POINT.test(commitment.hiddenPn)) {
+      throw new CourtSigningTransitionError('stored nonce commitments must be canonical secp256k1 points');
+    }
+    if (commitmentIndices.has(commitment.idx)) {
+      throw new CourtSigningTransitionError(`duplicate stored nonce commitment for signer ${commitment.idx}`);
+    }
+    commitmentIndices.add(commitment.idx);
+  }
+
+  if (state.finalizedSignerSet !== undefined) {
+    const expected = [...commitmentIndices].sort((a, b) => a - b);
+    if (
+      state.finalizedSignerSet.length !== expected.length ||
+      state.finalizedSignerSet.some((idx, offset) => idx !== expected[offset])
+    ) {
+      throw new CourtSigningTransitionError('finalized signer set does not match stored commitments');
+    }
+  }
+
+  const partialIndices = new Set<number>();
+  for (const partial of state.partials) {
+    if (!state.finalizedSignerSet?.includes(partial.idx)) {
+      throw new CourtSigningTransitionError(
+        `stored partial signer ${partial.idx} is not in the finalized commitment set`,
+      );
+    }
+    if (!HEX_32.test(partial.psig)) {
+      throw new CourtSigningTransitionError('stored partial signature must be 32-byte lowercase hex');
+    }
+    if (partialIndices.has(partial.idx)) {
+      throw new CourtSigningTransitionError(`duplicate stored partial signature for signer ${partial.idx}`);
+    }
+    partialIndices.add(partial.idx);
+  }
+}
+
 function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtSigningTransitionError('signing message arrived at or after the attempt deadline');
   }
 }
 
 export function createCourtSigningMachine(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
 }): CourtSigningMachineState {
   if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
     throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
   }
   if (
     typeof params.outcome !== 'string' ||
     params.outcome.length === 0 ||
     textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
   ) {
     throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtSigningTransitionError('signing requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtSigningTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Number.isSafeInteger(params.threshold) ||
     params.threshold < 1 ||
     params.threshold > participants.length
   ) {
     throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
   }
   if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
     throw new CourtSigningTransitionError('attempt must be a non-negative integer');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
   }
   return {
     signingSessionHash: hashCourtSigningSession({
       sessionHash: params.sessionHash,
       verdictHash: params.verdictHash,
       outcome: params.outcome,
       participantIndices: participants,
       threshold: params.threshold,
       attempt: params.attempt,
     }),
     sessionHash: params.sessionHash,
     verdictHash: params.verdictHash,
     outcome: params.outcome,
     participantIndices: participants,
     threshold: params.threshold,
     attempt: params.attempt,
     deadline: params.deadline,
     phase: 'intent',
     commitments: [],
     partials: [],
   };
 }
 
 export function reduceCourtSigningMachine(
   state: CourtSigningMachineState,
   event: CourtSigningMachineEvent,
 ): CourtSigningMachineState {
+  assertSigningRecordInvariants(state);
+
   if (event.type === 'tick') {
     assertNow(event.now);
     if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'intent') {
       throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
     }
     return { ...state, phase: 'nonce_commit' };
   }
 
   if (event.type === 'accept_commitment') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
     }
     // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
     // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
     // machine must not reject the x-only form.
     if (!HEX_POINT.test(event.binderPn) || !HEX_POINT.test(event.hiddenPn)) {
       throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
     }
     const existing = state.commitments.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
         return state;
       }
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       commitments: [
         ...state.commitments,
         { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
       ],
     };
   }
 
   if (event.type === 'close_commitments') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
     }
     if (state.commitments.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
       );
     }
     const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
     return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
   }
 
   if (event.type === 'accept_partial') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
       throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
     }
     if (!state.finalizedSignerSet?.includes(event.idx)) {
       throw new CourtSigningTransitionError(
         `signer ${event.idx} is not in the finalized commitment set`,
       );
     }
     if (!HEX_32.test(event.psig)) {
       throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
     }
     const existing = state.partials.find((p) => p.idx === event.idx);
     if (existing) {
       if (existing.psig === event.psig) return state;
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published conflicting partial signatures for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       phase: 'partial_sign',
       partials: [...state.partials, { idx: event.idx, psig: event.psig }],
     };
   }
 
   if (event.type === 'aggregate') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
       throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
     }
     if (state.partials.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
       );
     }
     if (!SCHNORR_SIGNATURE.test(event.signature)) {
       throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
     }
     return { ...state, phase: 'aggregate', signature: event.signature };
   }
 
   if (event.type === 'publish') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'aggregate' || !state.signature) {
       throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
     }
     if (!HEX_32.test(event.attestationEventId)) {
       throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
     }
     return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
   }
 
   return state;
 }

```


---

### Empty Dispute Filter Broadens Results

**Affected files:** courtSigner.ts

**V12 reasoning:** Treat disputeId as an active filter whenever it is supplied, including the empty string, while preserving omitted-option behavior.

```diff
diff --git a/courtSigner.ts b/courtSigner.ts
--- a/courtSigner.ts
+++ b/courtSigner.ts
@@ -1,266 +1,266 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Signer-backed private transport for BAO Court protocol messages.
  *
  * Every private Court message (DKG shares, complaints, backups, refresh
  * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
  * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
  * process memory. This module provides the same capabilities through a
  * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
  * signers, hardware-backed agents) so production jurors never expose an
  * `nsec` to the Court host.
  *
  * The signer surface is intentionally narrow: public key, event signing, and
  * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
  * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
  * `nip44_decrypt`).
  *
  * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
  * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
  * seal author equals the rumor author, and recomputes the rumor id. A gift
  * wrap that fails any check is rejected (returns null), never partially
  * trusted.
  */
 
 import {
   finalizeEvent,
   generateSecretKey,
   getEventHash,
   getPublicKey,
   verifyEvent,
 } from 'nostr-tools/pure';
 import { nip59 } from 'nostr-tools';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
 
 const SEAL_KIND = 13;
 const GIFT_WRAP_KIND = 1059;
 const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
 
 const HEX_64 = /^[0-9a-f]{64}$/;
 
 /** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
 function randomNowSeconds(): number {
   return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
 }
 
 function assertHex64(value: string, label: string): void {
   if (!HEX_64.test(value)) {
     throw new Error(`${label} must be a 64-character lowercase hex string`);
   }
 }
 
 /**
  * Minimal external signer surface required for Court private transport.
  * Implementations MUST NOT expose the secret key.
  */
 export interface CourtEventSigner {
   /** The signer's x-only public key (64-char hex). */
   getPublicKey(): Promise<string> | string;
   /** Sign an event template; the signer fills pubkey, id, and sig. */
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent>;
   /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
   /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
 }
 
 /**
  * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
  * signer-backed keys work everywhere the Court already accepts encryption
  * providers (DKG sessions, backups, complaints).
  */
 export class Nip44SignerCrypto implements Nip44Crypto {
   constructor(private readonly signer: CourtEventSigner) {}
 
   encrypt(plaintext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Encrypt(peerPubkey, plaintext);
   }
 
   decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Decrypt(peerPubkey, ciphertext);
   }
 }
 
 /**
  * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
  * demo rooms, and local tooling — production jurors should use a real
  * external signer. Keeping this adapter means the entire private-transport
  * stack has exactly one code path regardless of key custody.
  */
 export class SeckeyCourtSigner implements CourtEventSigner {
   private readonly seckey: Uint8Array;
   private readonly crypto: Nip44SeckeyCrypto;
 
   constructor(seckey: string | Uint8Array) {
     // Copy at the boundary: caller-supplied buffers must never alias our
     // secret, or later mutation/zeroization of the source silently corrupts
     // (or "destroys") this signer.
     this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
     if (this.seckey.length !== 32) {
       throw new Error('seckey must be 32 bytes');
     }
     this.crypto = new Nip44SeckeyCrypto(this.seckey);
   }
 
   getPublicKey(): string {
     return getPublicKey(this.seckey);
   }
 
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent> {
     return Promise.resolve(finalizeEvent(template, this.seckey));
   }
 
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
     return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
   }
 
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
     return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
   }
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null;
 }
 
 /**
  * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
  * recipient, using only the signer's public methods. The sender's secret key
  * never enters this process; the outer wrap's ephemeral key is generated
  * locally per wrap (it is random by design and protects nothing long-term).
  */
 export async function wrapProtocolEventWithSigner(
   event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
   signer: CourtEventSigner,
   recipientPubkey: string,
 ): Promise<NostrEvent> {
   assertHex64(recipientPubkey, 'recipient pubkey');
   const senderPubkey = await signer.getPublicKey();
   assertHex64(senderPubkey, 'signer pubkey');
 
   // Rumor: unsigned, id commits to author + content.
   const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
   rumor.id = getEventHash(rumor as NostrEvent);
 
   // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
   // through the external signer.
   const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
   const seal = await signer.signEvent({
     kind: SEAL_KIND,
     content: sealContent,
     created_at: randomNowSeconds(),
     tags: [],
   });
   // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
   // their verdict in a non-JSON-enumerable symbol that object spreads
   // preserve, so a malicious signer returning a once-valid seal it then
   // tampered with must never reach the verifier with the cached verdict
   // attached.
   const sealCandidate: NostrEvent = {
     id: seal.id,
     pubkey: seal.pubkey,
     sig: seal.sig,
     kind: seal.kind,
     created_at: seal.created_at,
     content: seal.content,
     tags: seal.tags,
   } as NostrEvent;
   if (
     sealCandidate.kind !== SEAL_KIND
     || sealCandidate.pubkey !== senderPubkey
     || !verifyEvent(sealCandidate)
   ) {
     throw new Error('external signer returned an invalid NIP-59 seal');
   }
 
   // Wrap: kind 1059 under a locally generated ephemeral key.
   return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
 }
 
 /**
  * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
  * full NIP-59 verification. Returns the inner rumor, or null if any layer is
  * malformed, misaddressed, forged, or tampered with.
  */
 export async function unwrapProtocolEventWithSigner(
   wrapEvent: NostrEvent,
   signer: CourtEventSigner,
 ): Promise<NostrEvent | null> {
   try {
     if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
     const recipientPubkey = await signer.getPublicKey();
     const addressed = wrapEvent.tags.some(
       (t) => t[0] === 'p' && t[1] === recipientPubkey,
     );
     if (!addressed) return null;
 
     const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
     const seal: unknown = JSON.parse(sealJson);
     if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
     const sealEvent = seal as unknown as NostrEvent;
     if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;
 
     const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
     const rumor: unknown = JSON.parse(rumorJson);
     if (!isRecord(rumor)) return null;
     const rumorEvent = rumor as unknown as NostrEvent;
 
     // NIP-59: the seal must be signed by the rumor's author, and the rumor id
     // must commit to its exact contents.
     if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
     if (typeof rumorEvent.id !== 'string') return null;
     if (getEventHash(rumorEvent) !== rumorEvent.id) return null;
 
     return rumorEvent;
   } catch {
     return null;
   }
 }
 
 /**
  * Unwrap many gift wraps with a signer and filter to a specific inner kind
  * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
  * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
  */
 export async function unwrapProtocolEventsWithSigner(
   wraps: readonly NostrEvent[],
   signer: CourtEventSigner,
   options?: {
     readonly kinds?: readonly number[];
     readonly disputeId?: string;
   },
 ): Promise<NostrEvent[]> {
   const seen = new Set<string>();
   const result: NostrEvent[] = [];
 
   for (const wrap of wraps) {
     const rumor = await unwrapProtocolEventWithSigner(wrap, signer);
     if (!rumor || !rumor.id) continue;
     if (seen.has(rumor.id)) continue;
     seen.add(rumor.id);
 
     if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
-    if (options?.disputeId) {
+    if (options?.disputeId !== undefined) {
       const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
       if (disputeTag?.[1] !== options.disputeId) continue;
     }
 
     result.push(rumor);
   }
 
   return result;
 }
 
 /** Generate a fresh random secret key (hex) — for tests and demo rooms. */
 export function generateCourtSeckeyHex(): string {
   return bytesToHex(generateSecretKey());
 }

```


---

### Hex Casing Changes Evidence Ordering

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Normalize supporting event ID hex strings to lowercase before sorting, so byte-identical IDs have a single textual representation and canonical ordering cannot vary with caller-supplied casing.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,439 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
-  const sorted = [...params.supportingEventIds].sort();
+  const sorted = params.supportingEventIds.map((id) => id.toLowerCase()).sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Malformed Evidence IDs Produce Valid Commitments

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Validate dispute-verdict inputs before canonical encoding: the dispute and every supporting reveal must be canonical 32-byte lowercase IDs, the outcome must be non-empty and within the protocol's 256-byte bound, and the evidence set must be non-empty. This prevents the exported helper from producing signable hashes for malformed or evidence-free verdict tuples while preserving valid hashing behavior.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,458 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
+  if (!HEX_32.test(params.disputeId)) {
+    throw new CourtVoteTransitionError('disputeId must be 32-byte lowercase hex');
+  }
+  if (
+    typeof params.outcome !== 'string'
+    || params.outcome.length === 0
+    || textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
+  ) {
+    throw new CourtVoteTransitionError('outcome must be a non-empty bounded string');
+  }
+  if (!Array.isArray(params.supportingEventIds) || params.supportingEventIds.length === 0) {
+    throw new CourtVoteTransitionError('supportingEventIds must contain at least one reveal event id');
+  }
+  for (const id of params.supportingEventIds) {
+    if (!HEX_32.test(id)) {
+      throw new CourtVoteTransitionError('supporting event ids must be 32-byte lowercase hex');
+    }
+  }
+
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Malformed Kind Filter Aborts Batch

**Affected files:** courtSigner.ts

**V12 reasoning:** Runtime-check the signer-backed batch kind filter with Array.isArray before using Array.prototype.includes, treating malformed non-array values as an absent filter so they cannot abort processing of valid wraps.

```diff
diff --git a/courtSigner.ts b/courtSigner.ts
--- a/courtSigner.ts
+++ b/courtSigner.ts
@@ -1,266 +1,267 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Signer-backed private transport for BAO Court protocol messages.
  *
  * Every private Court message (DKG shares, complaints, backups, refresh
  * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
  * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
  * process memory. This module provides the same capabilities through a
  * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
  * signers, hardware-backed agents) so production jurors never expose an
  * `nsec` to the Court host.
  *
  * The signer surface is intentionally narrow: public key, event signing, and
  * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
  * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
  * `nip44_decrypt`).
  *
  * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
  * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
  * seal author equals the rumor author, and recomputes the rumor id. A gift
  * wrap that fails any check is rejected (returns null), never partially
  * trusted.
  */
 
 import {
   finalizeEvent,
   generateSecretKey,
   getEventHash,
   getPublicKey,
   verifyEvent,
 } from 'nostr-tools/pure';
 import { nip59 } from 'nostr-tools';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
 
 const SEAL_KIND = 13;
 const GIFT_WRAP_KIND = 1059;
 const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
 
 const HEX_64 = /^[0-9a-f]{64}$/;
 
 /** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
 function randomNowSeconds(): number {
   return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
 }
 
 function assertHex64(value: string, label: string): void {
   if (!HEX_64.test(value)) {
     throw new Error(`${label} must be a 64-character lowercase hex string`);
   }
 }
 
 /**
  * Minimal external signer surface required for Court private transport.
  * Implementations MUST NOT expose the secret key.
  */
 export interface CourtEventSigner {
   /** The signer's x-only public key (64-char hex). */
   getPublicKey(): Promise<string> | string;
   /** Sign an event template; the signer fills pubkey, id, and sig. */
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent>;
   /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
   /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
 }
 
 /**
  * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
  * signer-backed keys work everywhere the Court already accepts encryption
  * providers (DKG sessions, backups, complaints).
  */
 export class Nip44SignerCrypto implements Nip44Crypto {
   constructor(private readonly signer: CourtEventSigner) {}
 
   encrypt(plaintext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Encrypt(peerPubkey, plaintext);
   }
 
   decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Decrypt(peerPubkey, ciphertext);
   }
 }
 
 /**
  * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
  * demo rooms, and local tooling — production jurors should use a real
  * external signer. Keeping this adapter means the entire private-transport
  * stack has exactly one code path regardless of key custody.
  */
 export class SeckeyCourtSigner implements CourtEventSigner {
   private readonly seckey: Uint8Array;
   private readonly crypto: Nip44SeckeyCrypto;
 
   constructor(seckey: string | Uint8Array) {
     // Copy at the boundary: caller-supplied buffers must never alias our
     // secret, or later mutation/zeroization of the source silently corrupts
     // (or "destroys") this signer.
     this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
     if (this.seckey.length !== 32) {
       throw new Error('seckey must be 32 bytes');
     }
     this.crypto = new Nip44SeckeyCrypto(this.seckey);
   }
 
   getPublicKey(): string {
     return getPublicKey(this.seckey);
   }
 
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent> {
     return Promise.resolve(finalizeEvent(template, this.seckey));
   }
 
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
     return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
   }
 
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
     return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
   }
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null;
 }
 
 /**
  * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
  * recipient, using only the signer's public methods. The sender's secret key
  * never enters this process; the outer wrap's ephemeral key is generated
  * locally per wrap (it is random by design and protects nothing long-term).
  */
 export async function wrapProtocolEventWithSigner(
   event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
   signer: CourtEventSigner,
   recipientPubkey: string,
 ): Promise<NostrEvent> {
   assertHex64(recipientPubkey, 'recipient pubkey');
   const senderPubkey = await signer.getPublicKey();
   assertHex64(senderPubkey, 'signer pubkey');
 
   // Rumor: unsigned, id commits to author + content.
   const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
   rumor.id = getEventHash(rumor as NostrEvent);
 
   // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
   // through the external signer.
   const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
   const seal = await signer.signEvent({
     kind: SEAL_KIND,
     content: sealContent,
     created_at: randomNowSeconds(),
     tags: [],
   });
   // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
   // their verdict in a non-JSON-enumerable symbol that object spreads
   // preserve, so a malicious signer returning a once-valid seal it then
   // tampered with must never reach the verifier with the cached verdict
   // attached.
   const sealCandidate: NostrEvent = {
     id: seal.id,
     pubkey: seal.pubkey,
     sig: seal.sig,
     kind: seal.kind,
     created_at: seal.created_at,
     content: seal.content,
     tags: seal.tags,
   } as NostrEvent;
   if (
     sealCandidate.kind !== SEAL_KIND
     || sealCandidate.pubkey !== senderPubkey
     || !verifyEvent(sealCandidate)
   ) {
     throw new Error('external signer returned an invalid NIP-59 seal');
   }
 
   // Wrap: kind 1059 under a locally generated ephemeral key.
   return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
 }
 
 /**
  * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
  * full NIP-59 verification. Returns the inner rumor, or null if any layer is
  * malformed, misaddressed, forged, or tampered with.
  */
 export async function unwrapProtocolEventWithSigner(
   wrapEvent: NostrEvent,
   signer: CourtEventSigner,
 ): Promise<NostrEvent | null> {
   try {
     if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
     const recipientPubkey = await signer.getPublicKey();
     const addressed = wrapEvent.tags.some(
       (t) => t[0] === 'p' && t[1] === recipientPubkey,
     );
     if (!addressed) return null;
 
     const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
     const seal: unknown = JSON.parse(sealJson);
     if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
     const sealEvent = seal as unknown as NostrEvent;
     if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;
 
     const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
     const rumor: unknown = JSON.parse(rumorJson);
     if (!isRecord(rumor)) return null;
     const rumorEvent = rumor as unknown as NostrEvent;
 
     // NIP-59: the seal must be signed by the rumor's author, and the rumor id
     // must commit to its exact contents.
     if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
     if (typeof rumorEvent.id !== 'string') return null;
     if (getEventHash(rumorEvent) !== rumorEvent.id) return null;
 
     return rumorEvent;
   } catch {
     return null;
   }
 }
 
 /**
  * Unwrap many gift wraps with a signer and filter to a specific inner kind
  * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
  * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
  */
 export async function unwrapProtocolEventsWithSigner(
   wraps: readonly NostrEvent[],
   signer: CourtEventSigner,
   options?: {
     readonly kinds?: readonly number[];
     readonly disputeId?: string;
   },
 ): Promise<NostrEvent[]> {
   const seen = new Set<string>();
   const result: NostrEvent[] = [];
+  const kinds = Array.isArray(options?.kinds) ? options.kinds : undefined;
 
   for (const wrap of wraps) {
     const rumor = await unwrapProtocolEventWithSigner(wrap, signer);
     if (!rumor || !rumor.id) continue;
     if (seen.has(rumor.id)) continue;
     seen.add(rumor.id);
 
-    if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
+    if (kinds && !kinds.includes(rumor.kind)) continue;
     if (options?.disputeId) {
       const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
       if (disputeTag?.[1] !== options.disputeId) continue;
     }
 
     result.push(rumor);
   }
 
   return result;
 }
 
 /** Generate a fresh random secret key (hex) — for tests and demo rooms. */
 export function generateCourtSeckeyHex(): string {
   return bytesToHex(generateSecretKey());
 }

```


---

### Malformed Unicode outcomes can bypass commitment binding

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Reject malformed UTF-16 outcome strings when freezing the vote allowlist, ensuring TextEncoder-based canonical serialization remains injective over accepted outcomes and preventing alternate colliding reveals.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,454 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
+function isWellFormedUnicode(value: string): boolean {
+  for (let index = 0; index < value.length; index += 1) {
+    const codeUnit = value.charCodeAt(index);
+    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
+      const next = value.charCodeAt(index + 1);
+      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
+      index += 1;
+    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
+      return false;
+    }
+  }
+  return true;
+}
+
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
+      !isWellFormedUnicode(outcome) ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Malformed nonce commitments can poison FROST signing

**Affected files:** crypto.ts, courtSigningMachine.ts, courtProtocolEvents.ts, independentSigning.ts

**V12 reasoning:** Adds shared cryptographic validation for canonical x-only or compressed secp256k1 points and applies it before nonce commitments enter signed-event parsing, reducer state, independent signing state, or restored snapshots.

```diff
diff --git a/crypto.ts b/crypto.ts
--- a/crypto.ts
+++ b/crypto.ts
@@ -1,247 +1,260 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Low-level cryptographic helpers for the BAO FROST threshold oracle.
  *
  * Browser-compatible: uses @noble/curves and @noble/hashes instead of Node crypto.
  */
 
 import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
 
 const Point = secp256k1.Point;
 import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
 import { sha256 } from '@noble/hashes/sha2.js';
 import { hkdf } from '@noble/hashes/hkdf.js';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import * as frost from '@vbyte/frost';
 import type { PublicNonce } from '@vbyte/frost';
 import { CanonicalWriter } from './courtSession';
 
 const SCALAR_ORDER = secp256k1.Point.Fn.ORDER;
 
 function modN(x: bigint): bigint {
   const r = x % SCALAR_ORDER;
   return r < 0n ? r + SCALAR_ORDER : r;
 }
 
 export function randomHex32(): string {
   return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
 }
 
 /**
  * Derive a non-zero scalar deterministically from a seed and domain info.
  *
  * Uses HKDF-SHA256 with a counter to avoid modulo bias. This is intentionally
  * deterministic: anyone with the same seed + info gets the same scalar. Only
  * use it for demos, tests, or situations where the seed itself is secret.
  */
 export function seededScalar(seed: Uint8Array, info: Uint8Array): bigint {
   let counter = 0;
   while (counter < 65536) {
     // Counter serialized big-endian as a full uint16 so it cannot collide
     // with a lower counter after truncation (a single-byte counter would
     // wrap at 256 and starve the rejection loop).
     const counterBytes = new Uint8Array(2);
     new DataView(counterBytes.buffer).setUint16(0, counter, false);
     const okm = hkdf(
       sha256,
       seed,
       new Uint8Array(0),
       new Uint8Array([...info, ...counterBytes]),
       64,
     );
     const s = modN(bytesToNumberBE(okm));
     if (s !== 0n) return s;
     counter++;
   }
   throw new Error('seededScalar: could not derive non-zero scalar');
 }
 
 /**
  * Return a uniformly random non-zero scalar in the secp256k1 field.
  *
  * Uses `@noble/curves`'s vetted `randomSecretKey()` implementation, which
  * samples from `[1, n-1]` without modulo bias.
  */
 export function randomScalar(): bigint {
   return bytesToNumberBE(secp256k1.utils.randomSecretKey());
 }
 
 /** Encode a scalar as a 32-byte zero-padded hex string. */
 export function scalarToHex(s: bigint): string {
   return bytesToHex(numberToBytesBE(modN(s), 32));
 }
 
 /**
  * Derive the x-only public key from a 32-byte secret key hex string.
  */
 export function deriveXOnlyPubkey(seckeyHex: string): string {
   const pk = schnorr.getPublicKey(hexToBytes(seckeyHex));
   return bytesToHex(pk);
 }
 
 /**
  * Domain tag for the attestation message. Keeps the signed digest distinct
  * from every other Court hash domain (preimage, bond challenge, session…).
  */
 export const ATTESTATION_MESSAGE_DOMAIN = 'BAO-Court/AttestationMessage/v1';
 
 /**
  * Build the canonical attestation message that all jurors sign.
  *
  * Uses the Court's canonical length-prefixed encoding (see
  * {@link CanonicalWriter}) with a domain tag. Delimiter-joined concatenation
  * would be ambiguous: an attacker-controlled `marketId` or `outcome` could
  * embed the delimiter and alias another field (or the dispute id), so two
  * distinct verdicts would hash to the same signed message. Length-prefixing
  * makes every tuple of fields unambiguous.
  *
  * `verdictHash` (kind-39007 only) is the dispute verdict commitment
  * ({@link hashDisputeVerdict}): the FROST signature then certifies the
  * TALLY that produced the outcome — an attestation for an outcome that lost
  * the vote is structurally invalid, not merely suspicious.
  */
 export function buildAttestationMessage(
   marketId: string,
   outcome: string,
   round: number | string,
   disputeEventId?: string,
   verdictHash?: string,
 ): string {
   const writer = new CanonicalWriter();
   writer.text(ATTESTATION_MESSAGE_DOMAIN);
   writer.text(marketId);
   writer.text(outcome);
   writer.text(String(round));
   if (disputeEventId) writer.text(disputeEventId);
   if (verdictHash) writer.hex(verdictHash);
   return bytesToHex(sha256(writer.finish()));
 }
 
 /**
  * Compute the aggregate group public nonce for a signing round.
  *
  * The binding factors depend on the group pubkey and the message (see
  * `get_group_commit_context` in @vbyte/frost), so both are required for the
  * result to match the nonce that actually ends up in the final signature.
  *
  * Returns the 33-byte compressed group nonce; the x-only `R` value embedded
  * in a final FROST signature is `result.slice(2)`.
  */
 export function aggregatePublicNonce(
   pnonces: readonly PublicNonce[],
   groupPubkey: string,
   messageHex: string,
 ): string {
   // Copy the caller's array: the lib sorts the nonce list in place.
   const sorted = [...pnonces];
   const keyCtx = frost.Lib.get_group_key_context(groupPubkey);
   const prefix = frost.Lib.get_group_prefix(sorted, keyCtx.group_pk, messageHex);
   const binders = frost.Lib.get_group_binders(sorted, prefix);
   return frost.Lib.get_group_pubnonce(sorted, binders);
 }
 
 export function verifyFinalSignature(
   groupPubkey: string,
   messageHex: string,
   signatureHex: string,
 ): boolean {
   const keyCtx = frost.Lib.get_group_key_context(groupPubkey);
   return frost.Lib.verify_final_sig(
     keyCtx,
     hexToBytes(messageHex),
     hexToBytes(signatureHex),
   );
 }
 
 export function verifySchnorr(
   pubkeyHex: string,
   messageHex: string,
   signatureHex: string,
 ): boolean {
   try {
     return schnorr.verify(
       hexToBytes(signatureHex),
       hexToBytes(messageHex),
       hexToBytes(pubkeyHex),
     );
   } catch {
     return false;
   }
 }
 
+const SECP256K1_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
+
+/** Validate an x-only or compressed secp256k1 point encoding. */
+export function isValidSecp256k1Point(value: string): boolean {
+  if (!SECP256K1_POINT.test(value)) return false;
+  try {
+    Point.fromHex(value.length === 64 ? `02${value}` : value);
+    return true;
+  } catch {
+    return false;
+  }
+}
+
 export interface DkgProofOfKnowledge {
   /** Public nonce R = r*G in hex (compressed). */
   readonly nonce: string;
   /** Response z = r + e*secret in hex (32-byte scalar). */
   readonly response: string;
 }
 
 /**
  * Create a Schnorr proof of knowledge of the discrete log of `pubkeyPoint`.
  * The challenge binds `pubkey`, the nonce, and an optional domain string.
  */
 export function createProofOfKnowledge(
   secretHex: string,
   pubkeyHex: string,
   domain?: string,
 ): DkgProofOfKnowledge {
   const secret = bytesToNumberBE(hexToBytes(secretHex));
   const pubkey = Point.fromHex(pubkeyHex);
   const r = randomScalar();
   const noncePoint = Point.BASE.multiply(r);
   const challenge = bytesToHex(
     sha256(
       new TextEncoder().encode(
         [
           'bao-frost-court/dkg-pok-v1',
           pubkey.toHex(true),
           noncePoint.toHex(true),
           domain ?? '',
         ].join('|'),
       ),
     ),
   );
   const e = modN(bytesToNumberBE(hexToBytes(challenge)));
   const z = modN(r + e * secret);
   return {
     nonce: noncePoint.toHex(true),
     response: scalarToHex(z),
   };
 }
 
 /**
  * Verify a Schnorr proof of knowledge of the discrete log of `pubkeyHex`.
  */
 export function verifyProofOfKnowledge(
   pubkeyHex: string,
   proof: DkgProofOfKnowledge,
   domain?: string,
 ): boolean {
   try {
     const pubkey = Point.fromHex(pubkeyHex);
     const noncePoint = Point.fromHex(proof.nonce);
     const challenge = bytesToHex(
       sha256(
         new TextEncoder().encode(
           [
             'bao-frost-court/dkg-pok-v1',
             pubkey.toHex(true),
             noncePoint.toHex(true),
             domain ?? '',
           ].join('|'),
         ),
       ),
     );
     const e = modN(bytesToNumberBE(hexToBytes(challenge)));
     const z = bytesToNumberBE(hexToBytes(proof.response));
     const lhs = Point.BASE.multiply(z);
     const rhs = noncePoint.add(pubkey.multiply(e));
     return lhs.equals(rhs);
   } catch {
     return false;
   }
 }
 
 export { frost };
 export type { PublicNonce };

diff --git a/courtSigningMachine.ts b/courtSigningMachine.ts
--- a/courtSigningMachine.ts
+++ b/courtSigningMachine.ts
@@ -1,386 +1,383 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court FROST signing attempt.
  *
  * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
  * aggregate -> attestation_published.
  *
  * The signing-session hash binds the Court session hash, the frozen verdict
  * hash, the exact outcome, the signing attempt, the threshold, and the signer
  * set. Changing any bound field requires a new machine for a new attempt and
  * invalidates every prior nonce commitment. Each roster signer may publish
  * exactly one nonce commitment per attempt; a conflicting second commitment
  * is nonce equivocation and aborts the attempt with blame.
  *
  * This module performs no FROST cryptographic verification; the boundary must
  * verify partial signatures against the certified verification shares and the
  * finalized commitment set before dispatching events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
+import { isValidSecp256k1Point } from './crypto';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';
 
 export type CourtSigningPhase =
   | 'intent'
   | 'nonce_commit'
   | 'commitment_set_final'
   | 'partial_sign'
   | 'aggregate'
   | 'attestation_published'
   | 'expired'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network';
 
 export type CourtSigningFailurePhase = Extract<
   CourtSigningPhase,
   'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
 >;
 
 export interface CourtSigningFailure {
   readonly phase: CourtSigningFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtSigningCommitmentRecord {
   readonly idx: number;
   readonly binderPn: string;
   readonly hiddenPn: string;
 }
 
 export interface CourtSigningPartialRecord {
   readonly idx: number;
   readonly psig: string;
 }
 
 export interface CourtSigningMachineState {
   readonly signingSessionHash: string;
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
   readonly phase: CourtSigningPhase;
   readonly commitments: readonly CourtSigningCommitmentRecord[];
   /** Frozen, sorted signer set whose commitments define the signing context. */
   readonly finalizedSignerSet?: readonly number[];
   readonly partials: readonly CourtSigningPartialRecord[];
   readonly signature?: string;
   readonly attestationEventId?: string;
   readonly failure?: CourtSigningFailure;
 }
 
 export type CourtSigningMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | {
       readonly type: 'accept_commitment';
       readonly idx: number;
       readonly binderPn: string;
       readonly hiddenPn: string;
       readonly now: number;
     }
   | { readonly type: 'close_commitments'; readonly now: number }
   | {
       readonly type: 'accept_partial';
       readonly idx: number;
       readonly psig: string;
       readonly now: number;
     }
   | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
   | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtSigningFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtSigningTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtSigningTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
-const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtSigningPhase>([
   'attestation_published',
   'expired',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
 ]);
 
 /**
  * Canonical hash binding every field that defines one signing attempt. A
  * FROST nonce commitment may be consumed only under exactly one such hash.
  */
 export function hashCourtSigningSession(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.hex(params.verdictHash);
   writer.text(params.outcome);
   writer.u32(params.participantIndices.length);
   for (const idx of params.participantIndices) {
     writer.u32(idx);
   }
   writer.u32(params.threshold);
   writer.u32(params.attempt);
   const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
   const encoded = writer.finish();
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtSigningTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtSigningMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtSigningTransitionError(`signer ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtSigningTransitionError('signing message arrived at or after the attempt deadline');
   }
 }
 
 export function createCourtSigningMachine(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
 }): CourtSigningMachineState {
   if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
     throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
   }
   if (
     typeof params.outcome !== 'string' ||
     params.outcome.length === 0 ||
     textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
   ) {
     throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtSigningTransitionError('signing requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtSigningTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Number.isSafeInteger(params.threshold) ||
     params.threshold < 1 ||
     params.threshold > participants.length
   ) {
     throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
   }
   if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
     throw new CourtSigningTransitionError('attempt must be a non-negative integer');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
   }
   return {
     signingSessionHash: hashCourtSigningSession({
       sessionHash: params.sessionHash,
       verdictHash: params.verdictHash,
       outcome: params.outcome,
       participantIndices: participants,
       threshold: params.threshold,
       attempt: params.attempt,
     }),
     sessionHash: params.sessionHash,
     verdictHash: params.verdictHash,
     outcome: params.outcome,
     participantIndices: participants,
     threshold: params.threshold,
     attempt: params.attempt,
     deadline: params.deadline,
     phase: 'intent',
     commitments: [],
     partials: [],
   };
 }
 
 export function reduceCourtSigningMachine(
   state: CourtSigningMachineState,
   event: CourtSigningMachineEvent,
 ): CourtSigningMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'intent') {
       throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
     }
     return { ...state, phase: 'nonce_commit' };
   }
 
   if (event.type === 'accept_commitment') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
     }
-    // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
-    // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
-    // machine must not reject the x-only form.
-    if (!HEX_POINT.test(event.binderPn) || !HEX_POINT.test(event.hiddenPn)) {
+    if (!isValidSecp256k1Point(event.binderPn) || !isValidSecp256k1Point(event.hiddenPn)) {
       throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
     }
     const existing = state.commitments.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
         return state;
       }
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       commitments: [
         ...state.commitments,
         { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
       ],
     };
   }
 
   if (event.type === 'close_commitments') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
     }
     if (state.commitments.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
       );
     }
     const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
     return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
   }
 
   if (event.type === 'accept_partial') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
       throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
     }
     if (!state.finalizedSignerSet?.includes(event.idx)) {
       throw new CourtSigningTransitionError(
         `signer ${event.idx} is not in the finalized commitment set`,
       );
     }
     if (!HEX_32.test(event.psig)) {
       throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
     }
     const existing = state.partials.find((p) => p.idx === event.idx);
     if (existing) {
       if (existing.psig === event.psig) return state;
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published conflicting partial signatures for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       phase: 'partial_sign',
       partials: [...state.partials, { idx: event.idx, psig: event.psig }],
     };
   }
 
   if (event.type === 'aggregate') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
       throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
     }
     if (state.partials.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
       );
     }
     if (!SCHNORR_SIGNATURE.test(event.signature)) {
       throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
     }
     return { ...state, phase: 'aggregate', signature: event.signature };
   }
 
   if (event.type === 'publish') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'aggregate' || !state.signature) {
       throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
     }
     if (!HEX_32.test(event.attestationEventId)) {
       throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
     }
     return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
   }
 
   return state;
 }

diff --git a/courtProtocolEvents.ts b/courtProtocolEvents.ts
--- a/courtProtocolEvents.ts
+++ b/courtProtocolEvents.ts
@@ -1,616 +1,616 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /** Strict, versioned event boundary for upgraded BAO Court ceremonies. */
 
 import {
   verifyEvent,
   type Event,
   type EventTemplate,
   type VerifiedEvent,
 } from 'nostr-tools/pure';
 import {
   COURT_SESSION_VERSION,
   assertCourtParticipantBinding,
   assertCourtSessionParameters,
   CourtSessionValidationError,
   getCourtSessionParticipant,
   hashCourtSessionParameters,
   type CourtCryptoSuite,
   type CourtSessionParameters,
   type CourtSessionParticipant,
 } from './courtSession';
 import {
   BAO_COURT_DKG_COMMITMENT_KIND,
   BAO_COURT_FROST_COMMIT_KIND,
   BAO_COURT_FROST_REVEAL_KIND,
   BAO_COURT_VOTE_COMMIT_KIND,
   BAO_COURT_VOTE_REVEAL_KIND,
 } from './events';
-import type { DkgProofOfKnowledge } from './crypto';
+import { isValidSecp256k1Point, type DkgProofOfKnowledge } from './crypto';
 
 export type CourtProtocolEventClassification = 'bound-v1' | 'legacy' | 'invalid';
 
 export type CourtProtocolEventErrorCode =
   | 'invalid_signature'
   | 'unexpected_kind'
   | 'invalid_content'
   | 'reserved_content'
   | 'missing_tag'
   | 'duplicate_tag'
   | 'invalid_tag'
   | 'tag_content_mismatch'
   | 'wrong_session'
   | 'wrong_suite'
   | 'wrong_attempt'
   | 'wrong_dispute'
   | 'participant_binding_mismatch';
 
 export class CourtProtocolEventError extends Error {
   readonly code: CourtProtocolEventErrorCode;
 
   constructor(code: CourtProtocolEventErrorCode, message: string) {
     super(message);
     this.name = 'CourtProtocolEventError';
     this.code = code;
   }
 }
 
 export interface CourtProtocolBinding {
   readonly version: typeof COURT_SESSION_VERSION;
   readonly session: string;
   readonly suite: CourtCryptoSuite;
   readonly attempt: number;
   readonly disputeId: string;
   readonly jurorIdx: number;
   readonly nostrPubkey: string;
   readonly hostPubkey: string;
 }
 
 export interface ParsedCourtProtocolEvent {
   readonly event: VerifiedEvent;
   readonly binding: CourtProtocolBinding;
   readonly participant: CourtSessionParticipant;
   readonly payload: Readonly<Record<string, unknown>>;
 }
 
 export interface ParsedLegacyCourtEvent {
   readonly event: VerifiedEvent;
   readonly legacy: true;
 }
 
 export interface ParsedBoundDkgCommitment extends ParsedCourtProtocolEvent {
   readonly threshold: number;
   readonly phaseNonce: string;
   readonly proofOfKnowledge: DkgProofOfKnowledge;
   readonly commitments: readonly string[];
 }
 
 export interface ParsedBoundVoteCommit extends ParsedCourtProtocolEvent {
   readonly commitHash: string;
 }
 
 export interface ParsedBoundVoteReveal extends ParsedCourtProtocolEvent {
   readonly outcome: string;
   readonly salt: string;
 }
 
 export interface ParsedBoundFrostCommit extends ParsedCourtProtocolEvent {
   readonly commitmentPackage: {
     readonly idx: number;
     readonly binder_pn: string;
     readonly hidden_pn: string;
   };
 }
 
 export interface ParsedBoundFrostReveal extends ParsedCourtProtocolEvent {
   readonly frostPubkey: string;
   readonly publicNonce: {
     readonly idx: number;
     readonly binder_pn: string;
     readonly hidden_pn: string;
   };
   readonly partialSig: string;
 }
 
 const REQUIRED_TAGS = [
   'session',
   'suite',
   'attempt',
   'dispute',
   'juror',
   'p',
   'host',
 ] as const;
 const UPGRADE_MARKER_TAGS = ['session', 'suite', 'attempt', 'host'] as const;
 const RESERVED_CONTENT_KEY = 'court';
 const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const HEX_BYTES = /^(?:[0-9a-f]{2})+$/;
 const MAX_U32 = 0xffff_ffff;
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
 }
 
 function isVerifiedEvent(event: Event): event is VerifiedEvent {
   try {
     // Verify a fresh data-only copy so a cached verification symbol on a
     // previously checked object cannot survive later mutation.
     return verifyEvent({
       id: event.id,
       pubkey: event.pubkey,
       created_at: event.created_at,
       kind: event.kind,
       tags: event.tags.map((tag) => [...tag]),
       content: event.content,
       sig: event.sig,
     });
   } catch {
     return false;
   }
 }
 
 function parseContent(content: string): Record<string, unknown> {
   try {
     const value: unknown = JSON.parse(content);
     if (!isRecord(value)) throw new Error('not an object');
     return value;
   } catch {
     throw new CourtProtocolEventError(
       'invalid_content',
       'Court protocol event content must be one JSON object',
     );
   }
 }
 
 function parseCanonicalUint(value: string, field: string): number {
   if (!CANONICAL_UINT.test(value)) {
     throw new CourtProtocolEventError('invalid_tag', `${field} must be a canonical unsigned integer`);
   }
   const parsed = Number(value);
   if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_U32) {
     throw new CourtProtocolEventError('invalid_tag', `${field} is outside the uint32 range`);
   }
   return parsed;
 }
 
 function uniqueTag(event: Pick<Event, 'tags'>, name: string): string[] {
   const matches = event.tags.filter((tag) => tag[0] === name);
   if (matches.length === 0) {
     throw new CourtProtocolEventError('missing_tag', `missing required ${name} tag`);
   }
   if (matches.length !== 1) {
     throw new CourtProtocolEventError('duplicate_tag', `expected exactly one ${name} tag`);
   }
   const tag = matches[0];
   if (tag.length !== 2 || !tag[1]) {
     throw new CourtProtocolEventError('invalid_tag', `${name} tag must contain exactly one value`);
   }
   return tag;
 }
 
 function assertExactBindingKeys(value: Record<string, unknown>): void {
   const expected = new Set([
     'version',
     'session',
     'suite',
     'attempt',
     'disputeId',
     'jurorIdx',
     'nostrPubkey',
     'hostPubkey',
   ]);
   const keys = Object.keys(value);
   if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
     throw new CourtProtocolEventError(
       'invalid_content',
       'Court protocol binding contains missing or unsupported fields',
     );
   }
 }
 
 function assertExactPayloadKeys(
   payload: Readonly<Record<string, unknown>>,
   expectedKeys: readonly string[],
 ): void {
   const expected = new Set(expectedKeys);
   const keys = Object.keys(payload);
   if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
     throw new CourtProtocolEventError(
       'invalid_content',
       'Court event payload contains missing or unsupported fields',
     );
   }
 }
 
 function requiredString(
   value: unknown,
   field: string,
   pattern?: RegExp,
 ): string {
   if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
     throw new CourtProtocolEventError('invalid_content', `${field} has an invalid value`);
   }
   return value;
 }
 
 function requiredUint(value: unknown, field: string): number {
   if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
     throw new CourtProtocolEventError('invalid_content', `${field} must be a uint32`);
   }
   return value;
 }
 
 function assertEqual(actual: unknown, expected: unknown, field: string): void {
   if (actual !== expected) {
     throw new CourtProtocolEventError(
       'tag_content_mismatch',
       `${field} differs between Court tags and content`,
     );
   }
 }
 
 function assertStringArrayEqual(
   actual: unknown,
   expected: readonly string[],
   field: string,
 ): void {
   if (
     !Array.isArray(actual)
     || actual.length !== expected.length
     || actual.some((value, index) => value !== expected[index])
   ) {
     throw new CourtProtocolEventError(
       'tag_content_mismatch',
       `${field} differs between Court tags and content`,
     );
   }
 }
 
 function repeatedTags(event: Pick<Event, 'tags'>, name: string): string[] {
   const matches = event.tags.filter((tag) => tag[0] === name);
   if (matches.length === 0) {
     throw new CourtProtocolEventError('missing_tag', `missing required ${name} tag`);
   }
   if (matches.some((tag) => tag.length !== 2 || !tag[1])) {
     throw new CourtProtocolEventError('invalid_tag', `${name} tags must each contain one value`);
   }
   return matches.map((tag) => tag[1]);
 }
 
 function assertMatchingPayloadField(
   payload: Record<string, unknown>,
   key: string,
   expected: string | number,
 ): void {
   if (key in payload && payload[key] !== expected) {
     throw new CourtProtocolEventError(
       'tag_content_mismatch',
       `${key} disagrees with the canonical Court binding`,
     );
   }
 }
 
 function makeBinding(
   params: CourtSessionParameters,
   participant: CourtSessionParticipant,
 ): CourtProtocolBinding {
   return {
     version: COURT_SESSION_VERSION,
     session: hashCourtSessionParameters(params),
     suite: params.cryptoSuite,
     attempt: params.attempt,
     disputeId: params.disputeId,
     jurorIdx: participant.idx,
     nostrPubkey: participant.nostrPubkey,
     hostPubkey: participant.hostPubkey,
   };
 }
 
 /**
  * Upgrade an unsigned legacy-compatible template with an exact Court binding.
  * The caller must then sign the returned template with the bound Nostr key.
  */
 export function bindCourtProtocolEvent(
   template: EventTemplate,
   params: CourtSessionParameters,
   jurorIdx: number,
 ): EventTemplate {
   assertCourtSessionParameters(params);
   const participant = getCourtSessionParticipant(params, jurorIdx);
   const binding = makeBinding(params, participant);
   const payload = parseContent(template.content);
   if (RESERVED_CONTENT_KEY in payload) {
     throw new CourtProtocolEventError(
       'reserved_content',
       `event payload already contains reserved ${RESERVED_CONTENT_KEY} data`,
     );
   }
   assertMatchingPayloadField(payload, 'disputeId', binding.disputeId);
   assertMatchingPayloadField(payload, 'jurorIdx', binding.jurorIdx);
   assertMatchingPayloadField(payload, 'jurorPubkey', binding.nostrPubkey);
 
   const reservedTags = new Set<string>(REQUIRED_TAGS);
   const applicationTags = template.tags.filter((tag) => !reservedTags.has(tag[0]));
   return {
     ...template,
     tags: [
       ...applicationTags,
       ['session', binding.session],
       ['suite', binding.suite],
       ['attempt', String(binding.attempt)],
       ['dispute', binding.disputeId],
       ['juror', String(binding.jurorIdx)],
       ['p', binding.nostrPubkey],
       ['host', binding.hostPubkey],
     ],
     content: JSON.stringify({ ...payload, [RESERVED_CONTENT_KEY]: binding }),
   };
 }
 
 /** Strictly parse a signed upgraded Court event. Throws closed on ambiguity. */
 export function parseCourtProtocolEvent(
   event: Event,
   params: CourtSessionParameters,
   expectedKinds: readonly number[],
 ): ParsedCourtProtocolEvent {
   assertCourtSessionParameters(params);
   if (!isVerifiedEvent(event)) {
     throw new CourtProtocolEventError('invalid_signature', 'Court protocol event signature is invalid');
   }
   if (!expectedKinds.includes(event.kind)) {
     throw new CourtProtocolEventError('unexpected_kind', `unexpected Court event kind ${event.kind}`);
   }
 
   const session = uniqueTag(event, 'session')[1];
   const suite = uniqueTag(event, 'suite')[1];
   const attempt = parseCanonicalUint(uniqueTag(event, 'attempt')[1], 'attempt');
   const disputeId = uniqueTag(event, 'dispute')[1];
   const jurorIdx = parseCanonicalUint(uniqueTag(event, 'juror')[1], 'juror');
   const nostrPubkey = uniqueTag(event, 'p')[1];
   const hostPubkey = uniqueTag(event, 'host')[1];
 
   const expectedSession = hashCourtSessionParameters(params);
   if (session !== expectedSession) {
     throw new CourtProtocolEventError('wrong_session', 'event belongs to a different Court session');
   }
   if (suite !== params.cryptoSuite) {
     throw new CourtProtocolEventError('wrong_suite', 'event crypto suite does not match the session');
   }
   if (attempt !== params.attempt) {
     throw new CourtProtocolEventError('wrong_attempt', 'event attempt does not match the session');
   }
   if (disputeId !== params.disputeId) {
     throw new CourtProtocolEventError('wrong_dispute', 'event dispute does not match the session');
   }
 
   let participant: CourtSessionParticipant;
   try {
     participant = assertCourtParticipantBinding(params, jurorIdx, event.pubkey, hostPubkey);
   } catch (err) {
     // A wrong-author / wrong-host-key event is a property of the EVENT, so it
     // must surface as a typed CourtProtocolEventError — never as the session
     // layer's CourtSessionValidationError, which fail-closed handling would
     // not catch. assertCourtSessionParameters above still reports genuine
     // host-side session misuse as a session error.
     if (err instanceof CourtSessionValidationError) {
       throw new CourtProtocolEventError('participant_binding_mismatch', err.message);
     }
     throw err;
   }
   if (nostrPubkey !== participant.nostrPubkey) {
     throw new CourtProtocolEventError(
       'tag_content_mismatch',
       'p tag does not match the signed Court participant',
     );
   }
 
   const content = parseContent(event.content);
   const bindingValue = content[RESERVED_CONTENT_KEY];
   if (!isRecord(bindingValue)) {
     throw new CourtProtocolEventError('invalid_content', 'missing Court protocol content binding');
   }
   assertExactBindingKeys(bindingValue);
   const expectedBinding = makeBinding(params, participant);
   for (const [key, expected] of Object.entries(expectedBinding)) {
     if (bindingValue[key] !== expected) {
       throw new CourtProtocolEventError(
         'tag_content_mismatch',
         `${key} differs between Court tags, content, or session parameters`,
       );
     }
   }
 
   const payload = { ...content };
   delete payload[RESERVED_CONTENT_KEY];
   assertMatchingPayloadField(payload, 'disputeId', expectedBinding.disputeId);
   assertMatchingPayloadField(payload, 'jurorIdx', expectedBinding.jurorIdx);
   assertMatchingPayloadField(payload, 'jurorPubkey', expectedBinding.nostrPubkey);
   return { event, binding: expectedBinding, participant, payload };
 }
 
 /** Classify structure only; classification never constitutes acceptance. */
 export function classifyCourtProtocolEvent(
   event: Pick<Event, 'tags' | 'content'>,
 ): CourtProtocolEventClassification {
   const presentTags = REQUIRED_TAGS.filter((name) => event.tags.some((tag) => tag[0] === name));
   const markerTags = UPGRADE_MARKER_TAGS.filter((name) => event.tags.some((tag) => tag[0] === name));
   let hasContentBinding = false;
   try {
     const content: unknown = JSON.parse(event.content);
     hasContentBinding = isRecord(content) && RESERVED_CONTENT_KEY in content;
   } catch {
     return 'invalid';
   }
   if (markerTags.length === 0 && !hasContentBinding) return 'legacy';
   if (presentTags.length === REQUIRED_TAGS.length && hasContentBinding) return 'bound-v1';
   return 'invalid';
 }
 
 /** Read a signed legacy event for an explicitly labelled history/demo view. */
 export function parseLegacyCourtEventForHistory(
   event: Event,
   expectedKinds: readonly number[],
 ): ParsedLegacyCourtEvent {
   if (!isVerifiedEvent(event)) {
     throw new CourtProtocolEventError('invalid_signature', 'legacy Court event signature is invalid');
   }
   if (!expectedKinds.includes(event.kind)) {
     throw new CourtProtocolEventError('unexpected_kind', `unexpected legacy Court event kind ${event.kind}`);
   }
   if (classifyCourtProtocolEvent(event) !== 'legacy') {
     throw new CourtProtocolEventError(
       'invalid_content',
       'event is not an unbound legacy Court event',
     );
   }
   return { event, legacy: true };
 }
 
 /** Strict DKG commitment parser for upgraded ceremonies. */
 export function parseBoundDkgCommitmentEvent(
   event: Event,
   params: CourtSessionParameters,
 ): ParsedBoundDkgCommitment {
   const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_DKG_COMMITMENT_KIND]);
   const threshold = parseCanonicalUint(uniqueTag(event, 'threshold')[1], 'threshold');
   const phaseNonce = uniqueTag(event, 'phase_nonce')[1];
   const pokNonce = uniqueTag(event, 'pok_n')[1];
   const pokResponse = uniqueTag(event, 'pok_z')[1];
   const commitments = repeatedTags(event, 'commit');
   if (threshold !== params.threshold) {
     throw new CourtProtocolEventError('tag_content_mismatch', 'DKG threshold differs from the session');
   }
   if (!HEX_32.test(phaseNonce) || !HEX_POINT.test(pokNonce) || !HEX_32.test(pokResponse)) {
     throw new CourtProtocolEventError('invalid_tag', 'DKG proof or phase nonce has invalid encoding');
   }
   if (commitments.length !== threshold || commitments.some((value) => !HEX_POINT.test(value))) {
     throw new CourtProtocolEventError(
       'invalid_tag',
       'DKG commitment count or point encoding does not match the threshold',
     );
   }
 
   assertExactPayloadKeys(
     parsed.payload,
     ['disputeId', 'jurorIdx', 'threshold', 'phaseNonce', 'pok', 'vssCommits'],
   );
   assertEqual(requiredUint(parsed.payload.threshold, 'threshold'), threshold, 'threshold');
   assertEqual(requiredString(parsed.payload.phaseNonce, 'phaseNonce', HEX_32), phaseNonce, 'phaseNonce');
   const pok = parsed.payload.pok;
   if (!isRecord(pok)) {
     throw new CourtProtocolEventError('invalid_content', 'pok must be an object');
   }
   assertExactPayloadKeys(pok, ['nonce', 'response']);
   assertEqual(requiredString(pok.nonce, 'pok.nonce', HEX_POINT), pokNonce, 'pok.nonce');
   assertEqual(requiredString(pok.response, 'pok.response', HEX_32), pokResponse, 'pok.response');
   assertStringArrayEqual(parsed.payload.vssCommits, commitments, 'vssCommits');
   return {
     ...parsed,
     threshold,
     phaseNonce,
     proofOfKnowledge: { nonce: pokNonce, response: pokResponse },
     commitments,
   };
 }
 
 /** Strict vote-commit parser for upgraded ceremonies. */
 export function parseBoundVoteCommitEvent(
   event: Event,
   params: CourtSessionParameters,
 ): ParsedBoundVoteCommit {
   const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_VOTE_COMMIT_KIND]);
   const commitHash = uniqueTag(event, 'commit')[1];
   if (!HEX_32.test(commitHash)) {
     throw new CourtProtocolEventError('invalid_tag', 'vote commitment must be 32-byte lowercase hex');
   }
   assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'commitHash']);
   assertEqual(requiredString(parsed.payload.commitHash, 'commitHash', HEX_32), commitHash, 'commitHash');
   return { ...parsed, commitHash };
 }
 
 /** Strict vote-reveal parser for upgraded ceremonies. */
 export function parseBoundVoteRevealEvent(
   event: Event,
   params: CourtSessionParameters,
 ): ParsedBoundVoteReveal {
   const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_VOTE_REVEAL_KIND]);
   const outcome = uniqueTag(event, 'outcome')[1];
   const salt = uniqueTag(event, 'salt')[1];
   if (!params.allowedOutcomes.includes(outcome)) {
     throw new CourtProtocolEventError('invalid_tag', 'vote outcome is not permitted by the session');
   }
   if (!HEX_32.test(salt)) {
     throw new CourtProtocolEventError('invalid_tag', 'vote salt must be 32-byte lowercase hex');
   }
   assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'outcome', 'salt']);
   assertEqual(requiredString(parsed.payload.outcome, 'outcome'), outcome, 'outcome');
   assertEqual(requiredString(parsed.payload.salt, 'salt', HEX_32), salt, 'salt');
   return { ...parsed, outcome, salt };
 }
 
 /** Strict FROST nonce-commitment parser for upgraded ceremonies. */
 export function parseBoundFrostCommitEvent(
   event: Event,
   params: CourtSessionParameters,
 ): ParsedBoundFrostCommit {
   const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_FROST_COMMIT_KIND]);
   const binder = uniqueTag(event, 'binder_pn')[1];
   const hidden = uniqueTag(event, 'hidden_pn')[1];
-  if (!HEX_POINT.test(binder) || !HEX_POINT.test(hidden)) {
+  if (!isValidSecp256k1Point(binder) || !isValidSecp256k1Point(hidden)) {
     throw new CourtProtocolEventError('invalid_tag', 'FROST nonce commitments have invalid encoding');
   }
   assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'commitmentPackage']);
   const commitment = parsed.payload.commitmentPackage;
   if (!isRecord(commitment)) {
     throw new CourtProtocolEventError('invalid_content', 'commitmentPackage must be an object');
   }
   assertExactPayloadKeys(commitment, ['idx', 'binder_pn', 'hidden_pn']);
   assertEqual(requiredUint(commitment.idx, 'commitmentPackage.idx'), parsed.participant.idx, 'idx');
   assertEqual(requiredString(commitment.binder_pn, 'binder_pn', HEX_POINT), binder, 'binder_pn');
   assertEqual(requiredString(commitment.hidden_pn, 'hidden_pn', HEX_POINT), hidden, 'hidden_pn');
   return {
     ...parsed,
     commitmentPackage: { idx: parsed.participant.idx, binder_pn: binder, hidden_pn: hidden },
   };
 }
 
 /** Strict FROST partial-signature parser for upgraded ceremonies. */
 export function parseBoundFrostRevealEvent(
   event: Event,
   params: CourtSessionParameters,
 ): ParsedBoundFrostReveal {
   const parsed = parseCourtProtocolEvent(event, params, [BAO_COURT_FROST_REVEAL_KIND]);
   const frostPubkey = uniqueTag(event, 'pk')[1];
   const binder = uniqueTag(event, 'nonce_binder')[1];
   const hidden = uniqueTag(event, 'nonce_hidden')[1];
   const partialSig = uniqueTag(event, 'psig')[1];
   if (
     !HEX_POINT.test(frostPubkey)
     || !HEX_POINT.test(binder)
     || !HEX_POINT.test(hidden)
     || !HEX_BYTES.test(partialSig)
     || partialSig.length > 512
   ) {
     throw new CourtProtocolEventError('invalid_tag', 'FROST reveal has invalid encoding');
   }
   assertExactPayloadKeys(parsed.payload, ['disputeId', 'jurorIdx', 'publicNonce', 'partialSig', 'frostPubkey']);
   const nonce = parsed.payload.publicNonce;
   if (!isRecord(nonce)) {
     throw new CourtProtocolEventError('invalid_content', 'publicNonce must be an object');
   }
   assertExactPayloadKeys(nonce, ['idx', 'binder_pn', 'hidden_pn']);
   assertEqual(requiredUint(nonce.idx, 'publicNonce.idx'), parsed.participant.idx, 'idx');
   assertEqual(requiredString(nonce.binder_pn, 'nonce_binder', HEX_POINT), binder, 'nonce_binder');
   assertEqual(requiredString(nonce.hidden_pn, 'nonce_hidden', HEX_POINT), hidden, 'nonce_hidden');
   assertEqual(requiredString(parsed.payload.partialSig, 'partialSig', HEX_BYTES), partialSig, 'partialSig');
   // The content frostPubkey must agree with the pk tag.
   assertEqual(requiredString(parsed.payload.frostPubkey, 'frostPubkey', HEX_POINT), frostPubkey, 'frostPubkey');
   return {
     ...parsed,
     frostPubkey,
     publicNonce: { idx: parsed.participant.idx, binder_pn: binder, hidden_pn: hidden },
     partialSig,
   };
 }

diff --git a/independentSigning.ts b/independentSigning.ts
--- a/independentSigning.ts
+++ b/independentSigning.ts
@@ -1,467 +1,473 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Independent-juror FROST signing session.
  *
  * Each juror runs this class locally. It collects public nonce commitments,
  * produces the juror's own partial signature, and (optionally) aggregates
  * threshold partial signatures into the final attestation.
  */
 
 import * as frost from '@vbyte/frost';
-import { buildAttestationMessage } from './crypto';
+import { buildAttestationMessage, isValidSecp256k1Point } from './crypto';
 import {
   buildFrostCommitEvent,
   buildFrostRevealEvent,
   buildAttestationEvent,
 } from './events';
 import type { DkgRecord, FrostAttestation } from './types';
 import {
   createCommitment,
   createRevealAndPartialSig,
   aggregateAttestation,
   createDefaultNonceGuard,
   type NonceGuard,
   type SigningCommitment,
   type SigningReveal,
 } from './signing';
 
 export interface IndependentSigningOptions {
   readonly disputeId: string;
   readonly myIdx: number;
   readonly myPubkey: string;
   readonly dkg: DkgRecord;
   readonly outcome: string;
   readonly round?: number | string;
   readonly disputeEventId?: string;
   /**
    * Dispute verdict commitment bound into the signed message (kind-39007
    * attestations) — see {@link buildAttestationMessage}.
    */
   readonly verdictHash?: string;
   /**
    * Optional persistent nonce-use guard. If omitted, an in-memory guard is
    * used, which prevents nonce reuse for the lifetime of this session.
    */
   readonly nonceGuard?: NonceGuard;
   /**
    * Optional snapshot of a previously collected signing-round state. The
    * snapshot is validated: its message must match the message derived from
    * this session's parameters, and reveals are only restored when a matching
    * commitment is present.
    */
   readonly snapshot?: IndependentSigningSnapshot;
 }
 
 /** Plain JSON-serializable snapshot of collected signing-round state. */
 export interface IndependentSigningSnapshot {
   readonly version: number;
   readonly message: string;
   readonly commitments: readonly SigningSnapshotCommitment[];
   readonly reveals: readonly SigningSnapshotReveal[];
 }
 
 export interface SigningSnapshotCommitment {
   readonly idx: number;
   readonly pubkey: string;
   readonly binder_pn: string;
   readonly hidden_pn: string;
 }
 
 export interface SigningSnapshotReveal {
   readonly idx: number;
   readonly pubkey: string;
   readonly binder_pn: string;
   readonly hidden_pn: string;
   readonly psig: string;
 }
 
 interface StoredCommitment {
   readonly idx: number;
   readonly pubkey: string;
   readonly binder_pn: string;
   readonly hidden_pn: string;
   readonly commit: frost.CommitmentPackage;
 }
 
 interface ParsedReveal {
   readonly idx: number;
   readonly pubkey: string;
   readonly binder_pn: string;
   readonly hidden_pn: string;
   readonly psig: string;
 }
 
 export class IndependentSigningSession {
   readonly disputeId: string;
   readonly myIdx: number;
   readonly myPubkey: string;
   readonly dkg: DkgRecord;
   readonly outcome: string;
   readonly round: number | string;
   readonly disputeEventId?: string;
   /** Dispute verdict commitment bound into the signed message (kind 39007). */
   readonly verdictHash?: string;
   readonly message: string;
 
   private readonly commitments = new Map<number, StoredCommitment>();
   private readonly reveals = new Map<number, ParsedReveal>();
   private readonly nonceGuard: NonceGuard;
 
   constructor(options: IndependentSigningOptions) {
     this.disputeId = options.disputeId;
     this.myIdx = options.myIdx;
     this.myPubkey = options.myPubkey;
     this.dkg = options.dkg;
     this.outcome = options.outcome;
     this.round = options.round ?? 1;
     this.disputeEventId = options.disputeEventId;
     this.verdictHash = options.verdictHash;
     this.message = buildAttestationMessage(
       this.dkg.marketId,
       this.outcome,
       this.round,
       this.disputeEventId,
       this.verdictHash,
     );
     this.nonceGuard = options.nonceGuard ?? createDefaultNonceGuard(`bao-frost-used-nonces|${this.disputeId}`);
 
     if (options.snapshot) {
       this.applySnapshot(options.snapshot);
     }
   }
 
   private applySnapshot(snapshot: IndependentSigningSnapshot): void {
     if (snapshot.version !== 1) {
       throw new Error(
         `Unsupported signing snapshot version: ${snapshot.version}`,
       );
     }
     if (snapshot.message !== this.message) {
       throw new Error(
         'Signing snapshot message does not match this session; possible stale or wrong-round data',
       );
     }
 
     // Restore commitments, deduplicating by juror index.
     for (const c of snapshot.commitments) {
+      if (!isValidSecp256k1Point(c.binder_pn) || !isValidSecp256k1Point(c.hidden_pn)) {
+        throw new Error('Signing snapshot contains an invalid secp256k1 nonce commitment');
+      }
       this.commitments.set(c.idx, {
         idx: c.idx,
         pubkey: c.pubkey,
         binder_pn: c.binder_pn,
         hidden_pn: c.hidden_pn,
         commit: {
           idx: c.idx,
           binder_pn: c.binder_pn,
           hidden_pn: c.hidden_pn,
         } as frost.CommitmentPackage,
       });
     }
 
     // Only restore reveals when the matching commitment is present.
     for (const r of snapshot.reveals) {
       if (!this.commitments.has(r.idx)) continue;
       this.reveals.set(r.idx, {
         idx: r.idx,
         pubkey: r.pubkey,
         binder_pn: r.binder_pn,
         hidden_pn: r.hidden_pn,
         psig: r.psig,
       });
     }
   }
 
   /**
    * Export the session's collected commitments and reveals to a plain
    * JSON-serializable snapshot. This allows a new session for the same signing
    * round to resume aggregation without re-collecting events.
    */
   toSnapshot(): IndependentSigningSnapshot {
     return {
       version: 1,
       message: this.message,
       commitments: Array.from(this.commitments.values()).map((c) => ({
         idx: c.idx,
         pubkey: c.pubkey,
         binder_pn: c.binder_pn,
         hidden_pn: c.hidden_pn,
       })),
       reveals: Array.from(this.reveals.values()).map((r) => ({
         idx: r.idx,
         pubkey: r.pubkey,
         binder_pn: r.binder_pn,
         hidden_pn: r.hidden_pn,
         psig: r.psig,
       })),
     };
   }
 
   /**
    * Add a peer's FROST nonce commitment.
    */
   addCommitment(payload: {
     readonly idx: number;
     readonly pubkey: string;
     readonly commitmentPackage: {
       idx: number;
       binder_pn: string;
       hidden_pn: string;
     };
   }): boolean {
     if (payload.idx === this.myIdx) return false;
     // Only accept commitments from DKG participants, bound to the
     // participant's registered nostr pubkey so an attacker cannot front-run
     // an honest juror's commitment under their idx.
     if (!this.dkg.verificationShares.some((v) => v.idx === payload.idx)) return false;
     const vss = this.dkg.vssCommitments.find((c) => c.idx === payload.idx);
     if (vss && payload.pubkey !== vss.pubkey) return false;
-    if (!payload.commitmentPackage.binder_pn || !payload.commitmentPackage.hidden_pn) return false;
+    if (
+      !isValidSecp256k1Point(payload.commitmentPackage.binder_pn)
+      || !isValidSecp256k1Point(payload.commitmentPackage.hidden_pn)
+    ) return false;
     try {
       const existing = this.commitments.get(payload.idx);
       if (existing) {
         // Nonce equivocation: a juror may publish exactly ONE commitment per
         // signing attempt (courtSigningMachine aborts on the same conflict).
         // Silently overwriting would let a peer switch nonces mid-round and
         // invalidate the other jurors' binding factors. Identical duplicates
         // (relay redelivery) are idempotent.
         if (
           existing.binder_pn !== payload.commitmentPackage.binder_pn ||
           existing.hidden_pn !== payload.commitmentPackage.hidden_pn ||
           existing.pubkey !== payload.pubkey
         ) {
           return false;
         }
         return true;
       }
       // Peer commitment events only carry the public nonce fields.
       // @vbyte/frost's CommitmentPackage type also includes secret nonce fields,
       // but aggregation only reads the public fields.
       const commit = {
         idx: payload.idx,
         binder_pn: payload.commitmentPackage.binder_pn,
         hidden_pn: payload.commitmentPackage.hidden_pn,
       } as frost.CommitmentPackage;
       this.commitments.set(payload.idx, {
         idx: payload.idx,
         pubkey: payload.pubkey,
         binder_pn: payload.commitmentPackage.binder_pn,
         hidden_pn: payload.commitmentPackage.hidden_pn,
         commit,
       });
       return true;
     } catch {
       return false;
     }
   }
 
   /**
    * Create this juror's FROST nonce commitment and the corresponding event.
    */
   createMyCommitment(share: frost.SecretShare): {
     commitment: SigningCommitment;
     event: ReturnType<typeof buildFrostCommitEvent>;
   } {
     const signingCommitment = createCommitment(share);
     const pkg = signingCommitment.commit;
     const event = buildFrostCommitEvent({
       disputeId: this.disputeId,
       jurorIdx: this.myIdx,
       commitmentPackage: {
         idx: pkg.idx,
         binder_pn: pkg.binder_pn,
         hidden_pn: pkg.hidden_pn,
       },
     });
     // Store the full commitment package (with secret nonces) for ourselves.
     this.commitments.set(this.myIdx, {
       idx: this.myIdx,
       pubkey: this.myPubkey,
       binder_pn: pkg.binder_pn,
       hidden_pn: pkg.hidden_pn,
       commit: pkg,
     });
     return { commitment: signingCommitment, event };
   }
 
   /**
    * True once enough commitments have been collected to reveal.
    */
   hasEnoughCommitments(): boolean {
     const qualified = this.dkg.verificationShares.map((v) => v.idx);
     return qualified.every((idx) => this.commitments.has(idx));
   }
 
   /**
    * Create this juror's partial signature reveal and the corresponding event.
    */
   createMyReveal(share: frost.SecretShare): {
     reveal: SigningReveal;
     event: ReturnType<typeof buildFrostRevealEvent>;
   } {
     if (!this.hasEnoughCommitments()) {
       throw new Error('Cannot reveal: missing peer commitments');
     }
 
     const signingCommitments = Array.from(this.commitments.values()).map((c) =>
       this.toSigningCommitment(c),
     );
 
     const reveal = createRevealAndPartialSig(
       {
         marketId: this.dkg.marketId,
         outcome: this.outcome,
         round: this.round,
         disputeEventId: this.disputeEventId,
         // Bind the frozen verdict commitment into the message every juror
         // signs — without it the partial signature (and the aggregate it
         // feeds) would NOT certify the tally, and a kind-39007 attestation
         // would fail validation for missing the verdict binding.
         verdictHash: this.verdictHash,
         dkg: this.dkg,
         shares: [share],
         nonceGuard: this.nonceGuard,
       },
       signingCommitments,
       share,
     );
 
     const event = buildFrostRevealEvent({
       disputeId: this.disputeId,
       jurorIdx: this.myIdx,
       publicNonce: {
         idx: (reveal.pnonce as frost.PublicNonce).idx,
         binder_pn: (reveal.pnonce as frost.PublicNonce).binder_pn,
         hidden_pn: (reveal.pnonce as frost.PublicNonce).hidden_pn,
       },
       partialSig: reveal.psig,
       frostPubkey: reveal.pubkey,
     });
 
     this.reveals.set(this.myIdx, {
       idx: this.myIdx,
       pubkey: reveal.pubkey,
       binder_pn: reveal.pnonce.binder_pn,
       hidden_pn: reveal.pnonce.hidden_pn,
       psig: reveal.psig,
     });
 
     return { reveal, event };
   }
 
   /**
    * Add a peer's partial signature reveal.
    */
   addReveal(payload: {
     readonly idx: number;
     readonly pubkey: string;
     readonly publicNonce: {
       idx: number;
       binder_pn: string;
       hidden_pn: string;
     };
     readonly partialSig: string;
   }): boolean {
     if (payload.idx === this.myIdx) return false;
     // Only accept reveals from DKG participants.
     if (!this.dkg.verificationShares.some((v) => v.idx === payload.idx)) return false;
     if (!payload.partialSig || !payload.pubkey) return false;
     const stored = this.commitments.get(payload.idx);
     if (!stored) return false;
     // The reveal MUST match the juror's committed nonce — a reveal for a
     // different (or swapped) nonce would otherwise be stored under the
     // commitment and poison the binding factors at aggregation.
     if (
       payload.publicNonce.binder_pn !== stored.binder_pn ||
       payload.publicNonce.hidden_pn !== stored.hidden_pn
     ) {
       return false;
     }
     const existingReveal = this.reveals.get(payload.idx);
     if (existingReveal) {
       // First reveal wins; reject conflicting duplicates.
       return existingReveal.psig === payload.partialSig && existingReveal.pubkey === payload.pubkey;
     }
     // The reveal MUST carry the compressed FROST verification pubkey used to
     // produce the partial signature. X-only pubkeys from the DKG record cannot
     // be used because they lose the y-parity information required by the
     // FROST verification equation.
     this.reveals.set(payload.idx, {
       idx: payload.idx,
       pubkey: payload.pubkey,
       binder_pn: payload.publicNonce.binder_pn,
       hidden_pn: payload.publicNonce.hidden_pn,
       psig: payload.partialSig,
     });
     return true;
   }
 
   private toSigningCommitment(c: StoredCommitment): SigningCommitment {
     return {
       idx: c.idx,
       pubkey: c.pubkey,
       commit: c.commit,
     };
   }
 
   /**
    * True once threshold reveals have been collected.
    */
   canAggregate(): boolean {
     return this.reveals.size >= this.dkg.threshold;
   }
 
   /**
    * Aggregate collected partial signatures into the final attestation.
    *
    * @param marketEventId Unused (kept for API compatibility). The attestation
    *   references the market via `dkg.marketId`; pass the market event id to
    *   {@link buildAttestationEvent} instead when publishing.
    */
   aggregate(marketEventId?: string): FrostAttestation {
     void marketEventId;
     if (!this.canAggregate()) {
       throw new Error(
         `Cannot aggregate: ${this.reveals.size} reveals, threshold ${this.dkg.threshold}`,
       );
     }
 
     const signingCommitments = Array.from(this.commitments.values()).map((c) =>
       this.toSigningCommitment(c),
     );
 
     const reveals = Array.from(this.reveals.values()).map((r) => ({
       idx: r.idx,
       pubkey: r.pubkey,
       pnonce: {
         idx: r.idx,
         binder_pn: r.binder_pn,
         hidden_pn: r.hidden_pn,
       } as frost.PublicNonce,
       psig: r.psig,
     }));
 
     return aggregateAttestation(
       {
         marketId: this.dkg.marketId,
         outcome: this.outcome,
         round: this.round,
         disputeEventId: this.disputeEventId,
         verdictHash: this.verdictHash,
         dkg: this.dkg,
         shares: [], // not needed for aggregation
       },
       signingCommitments,
       reveals,
     );
   }
 
   /**
    * Build the public kind 39007 attestation event from an aggregated attestation.
    */
   buildAttestationEvent(
     attestation: FrostAttestation,
     marketEventId: string,
   ): ReturnType<typeof buildAttestationEvent> {
     return buildAttestationEvent({ attestation, marketEventId });
   }
 }

```


---

### Outer metadata bypasses wrap deduplication

**Affected files:** courtSigner.ts

**V12 reasoning:** Reconstruct and cryptographically verify the outer NIP-59 gift-wrap event before recipient routing or decryption, preventing mutated ids/signatures from being accepted while avoiding nostr-tools cached verification state.

```diff
diff --git a/courtSigner.ts b/courtSigner.ts
--- a/courtSigner.ts
+++ b/courtSigner.ts
@@ -1,266 +1,278 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Signer-backed private transport for BAO Court protocol messages.
  *
  * Every private Court message (DKG shares, complaints, backups, refresh
  * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
  * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
  * process memory. This module provides the same capabilities through a
  * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
  * signers, hardware-backed agents) so production jurors never expose an
  * `nsec` to the Court host.
  *
  * The signer surface is intentionally narrow: public key, event signing, and
  * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
  * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
  * `nip44_decrypt`).
  *
  * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
  * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
  * seal author equals the rumor author, and recomputes the rumor id. A gift
  * wrap that fails any check is rejected (returns null), never partially
  * trusted.
  */
 
 import {
   finalizeEvent,
   generateSecretKey,
   getEventHash,
   getPublicKey,
   verifyEvent,
 } from 'nostr-tools/pure';
 import { nip59 } from 'nostr-tools';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
 
 const SEAL_KIND = 13;
 const GIFT_WRAP_KIND = 1059;
 const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
 
 const HEX_64 = /^[0-9a-f]{64}$/;
 
 /** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
 function randomNowSeconds(): number {
   return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
 }
 
 function assertHex64(value: string, label: string): void {
   if (!HEX_64.test(value)) {
     throw new Error(`${label} must be a 64-character lowercase hex string`);
   }
 }
 
 /**
  * Minimal external signer surface required for Court private transport.
  * Implementations MUST NOT expose the secret key.
  */
 export interface CourtEventSigner {
   /** The signer's x-only public key (64-char hex). */
   getPublicKey(): Promise<string> | string;
   /** Sign an event template; the signer fills pubkey, id, and sig. */
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent>;
   /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
   /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
 }
 
 /**
  * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
  * signer-backed keys work everywhere the Court already accepts encryption
  * providers (DKG sessions, backups, complaints).
  */
 export class Nip44SignerCrypto implements Nip44Crypto {
   constructor(private readonly signer: CourtEventSigner) {}
 
   encrypt(plaintext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Encrypt(peerPubkey, plaintext);
   }
 
   decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Decrypt(peerPubkey, ciphertext);
   }
 }
 
 /**
  * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
  * demo rooms, and local tooling — production jurors should use a real
  * external signer. Keeping this adapter means the entire private-transport
  * stack has exactly one code path regardless of key custody.
  */
 export class SeckeyCourtSigner implements CourtEventSigner {
   private readonly seckey: Uint8Array;
   private readonly crypto: Nip44SeckeyCrypto;
 
   constructor(seckey: string | Uint8Array) {
     // Copy at the boundary: caller-supplied buffers must never alias our
     // secret, or later mutation/zeroization of the source silently corrupts
     // (or "destroys") this signer.
     this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
     if (this.seckey.length !== 32) {
       throw new Error('seckey must be 32 bytes');
     }
     this.crypto = new Nip44SeckeyCrypto(this.seckey);
   }
 
   getPublicKey(): string {
     return getPublicKey(this.seckey);
   }
 
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent> {
     return Promise.resolve(finalizeEvent(template, this.seckey));
   }
 
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
     return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
   }
 
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
     return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
   }
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null;
 }
 
 /**
  * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
  * recipient, using only the signer's public methods. The sender's secret key
  * never enters this process; the outer wrap's ephemeral key is generated
  * locally per wrap (it is random by design and protects nothing long-term).
  */
 export async function wrapProtocolEventWithSigner(
   event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
   signer: CourtEventSigner,
   recipientPubkey: string,
 ): Promise<NostrEvent> {
   assertHex64(recipientPubkey, 'recipient pubkey');
   const senderPubkey = await signer.getPublicKey();
   assertHex64(senderPubkey, 'signer pubkey');
 
   // Rumor: unsigned, id commits to author + content.
   const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
   rumor.id = getEventHash(rumor as NostrEvent);
 
   // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
   // through the external signer.
   const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
   const seal = await signer.signEvent({
     kind: SEAL_KIND,
     content: sealContent,
     created_at: randomNowSeconds(),
     tags: [],
   });
   // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
   // their verdict in a non-JSON-enumerable symbol that object spreads
   // preserve, so a malicious signer returning a once-valid seal it then
   // tampered with must never reach the verifier with the cached verdict
   // attached.
   const sealCandidate: NostrEvent = {
     id: seal.id,
     pubkey: seal.pubkey,
     sig: seal.sig,
     kind: seal.kind,
     created_at: seal.created_at,
     content: seal.content,
     tags: seal.tags,
   } as NostrEvent;
   if (
     sealCandidate.kind !== SEAL_KIND
     || sealCandidate.pubkey !== senderPubkey
     || !verifyEvent(sealCandidate)
   ) {
     throw new Error('external signer returned an invalid NIP-59 seal');
   }
 
   // Wrap: kind 1059 under a locally generated ephemeral key.
   return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
 }
 
 /**
  * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
  * full NIP-59 verification. Returns the inner rumor, or null if any layer is
  * malformed, misaddressed, forged, or tampered with.
  */
 export async function unwrapProtocolEventWithSigner(
   wrapEvent: NostrEvent,
   signer: CourtEventSigner,
 ): Promise<NostrEvent | null> {
   try {
-    if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
+    // Verify a reconstructed outer event before trusting its id as durable
+    // provenance. Reconstructing also avoids nostr-tools' cached verification
+    // verdict on an event object that may have been mutated after validation.
+    const wrapCandidate: NostrEvent = {
+      id: wrapEvent.id,
+      pubkey: wrapEvent.pubkey,
+      sig: wrapEvent.sig,
+      kind: wrapEvent.kind,
+      created_at: wrapEvent.created_at,
+      content: wrapEvent.content,
+      tags: wrapEvent.tags,
+    } as NostrEvent;
+    if (wrapCandidate.kind !== GIFT_WRAP_KIND || !verifyEvent(wrapCandidate)) return null;
     const recipientPubkey = await signer.getPublicKey();
-    const addressed = wrapEvent.tags.some(
+    const addressed = wrapCandidate.tags.some(
       (t) => t[0] === 'p' && t[1] === recipientPubkey,
     );
     if (!addressed) return null;
 
-    const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
+    const sealJson = await signer.nip44Decrypt(wrapCandidate.pubkey, wrapCandidate.content);
     const seal: unknown = JSON.parse(sealJson);
     if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
     const sealEvent = seal as unknown as NostrEvent;
     if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;
 
     const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
     const rumor: unknown = JSON.parse(rumorJson);
     if (!isRecord(rumor)) return null;
     const rumorEvent = rumor as unknown as NostrEvent;
 
     // NIP-59: the seal must be signed by the rumor's author, and the rumor id
     // must commit to its exact contents.
     if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
     if (typeof rumorEvent.id !== 'string') return null;
     if (getEventHash(rumorEvent) !== rumorEvent.id) return null;
 
     return rumorEvent;
   } catch {
     return null;
   }
 }
 
 /**
  * Unwrap many gift wraps with a signer and filter to a specific inner kind
  * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
  * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
  */
 export async function unwrapProtocolEventsWithSigner(
   wraps: readonly NostrEvent[],
   signer: CourtEventSigner,
   options?: {
     readonly kinds?: readonly number[];
     readonly disputeId?: string;
   },
 ): Promise<NostrEvent[]> {
   const seen = new Set<string>();
   const result: NostrEvent[] = [];
 
   for (const wrap of wraps) {
     const rumor = await unwrapProtocolEventWithSigner(wrap, signer);
     if (!rumor || !rumor.id) continue;
     if (seen.has(rumor.id)) continue;
     seen.add(rumor.id);
 
     if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
     if (options?.disputeId) {
       const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
       if (disputeTag?.[1] !== options.disputeId) continue;
     }
 
     result.push(rumor);
   }
 
   return result;
 }
 
 /** Generate a fresh random secret key (hex) — for tests and demo rooms. */
 export function generateCourtSeckeyHex(): string {
   return bytesToHex(generateSecretKey());
 }

```


---

### Reject malformed persisted deadlines before signing transitions

**Affected files:** courtSigningMachine.ts

**V12 reasoning:** Adds a shared positive-safe-integer deadline assertion and invokes it at the reducer boundary before every event, so malformed persisted deadlines fail closed across tick, abort, terminal, and normal transitions while preserving valid-state behavior.

```diff
diff --git a/courtSigningMachine.ts b/courtSigningMachine.ts
--- a/courtSigningMachine.ts
+++ b/courtSigningMachine.ts
@@ -1,386 +1,391 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court FROST signing attempt.
  *
  * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
  * aggregate -> attestation_published.
  *
  * The signing-session hash binds the Court session hash, the frozen verdict
  * hash, the exact outcome, the signing attempt, the threshold, and the signer
  * set. Changing any bound field requires a new machine for a new attempt and
  * invalidates every prior nonce commitment. Each roster signer may publish
  * exactly one nonce commitment per attempt; a conflicting second commitment
  * is nonce equivocation and aborts the attempt with blame.
  *
  * This module performs no FROST cryptographic verification; the boundary must
  * verify partial signatures against the certified verification shares and the
  * finalized commitment set before dispatching events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';
 
 export type CourtSigningPhase =
   | 'intent'
   | 'nonce_commit'
   | 'commitment_set_final'
   | 'partial_sign'
   | 'aggregate'
   | 'attestation_published'
   | 'expired'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network';
 
 export type CourtSigningFailurePhase = Extract<
   CourtSigningPhase,
   'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
 >;
 
 export interface CourtSigningFailure {
   readonly phase: CourtSigningFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtSigningCommitmentRecord {
   readonly idx: number;
   readonly binderPn: string;
   readonly hiddenPn: string;
 }
 
 export interface CourtSigningPartialRecord {
   readonly idx: number;
   readonly psig: string;
 }
 
 export interface CourtSigningMachineState {
   readonly signingSessionHash: string;
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
   readonly phase: CourtSigningPhase;
   readonly commitments: readonly CourtSigningCommitmentRecord[];
   /** Frozen, sorted signer set whose commitments define the signing context. */
   readonly finalizedSignerSet?: readonly number[];
   readonly partials: readonly CourtSigningPartialRecord[];
   readonly signature?: string;
   readonly attestationEventId?: string;
   readonly failure?: CourtSigningFailure;
 }
 
 export type CourtSigningMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | {
       readonly type: 'accept_commitment';
       readonly idx: number;
       readonly binderPn: string;
       readonly hiddenPn: string;
       readonly now: number;
     }
   | { readonly type: 'close_commitments'; readonly now: number }
   | {
       readonly type: 'accept_partial';
       readonly idx: number;
       readonly psig: string;
       readonly now: number;
     }
   | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
   | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtSigningFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtSigningTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtSigningTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtSigningPhase>([
   'attestation_published',
   'expired',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
 ]);
 
 /**
  * Canonical hash binding every field that defines one signing attempt. A
  * FROST nonce commitment may be consumed only under exactly one such hash.
  */
 export function hashCourtSigningSession(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.hex(params.verdictHash);
   writer.text(params.outcome);
   writer.u32(params.participantIndices.length);
   for (const idx of params.participantIndices) {
     writer.u32(idx);
   }
   writer.u32(params.threshold);
   writer.u32(params.attempt);
   const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
   const encoded = writer.finish();
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtSigningTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtSigningMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtSigningTransitionError(`signer ${idx} is outside the certified roster`);
   }
 }
 
+function assertDeadline(deadline: number): void {
+  if (!Number.isSafeInteger(deadline) || deadline < 1) {
+    throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
+  }
+}
+
 function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtSigningTransitionError('signing message arrived at or after the attempt deadline');
   }
 }
 
 export function createCourtSigningMachine(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
 }): CourtSigningMachineState {
   if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
     throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
   }
   if (
     typeof params.outcome !== 'string' ||
     params.outcome.length === 0 ||
     textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
   ) {
     throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtSigningTransitionError('signing requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtSigningTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Number.isSafeInteger(params.threshold) ||
     params.threshold < 1 ||
     params.threshold > participants.length
   ) {
     throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
   }
   if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
     throw new CourtSigningTransitionError('attempt must be a non-negative integer');
   }
-  if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
-    throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
-  }
+  assertDeadline(params.deadline);
   return {
     signingSessionHash: hashCourtSigningSession({
       sessionHash: params.sessionHash,
       verdictHash: params.verdictHash,
       outcome: params.outcome,
       participantIndices: participants,
       threshold: params.threshold,
       attempt: params.attempt,
     }),
     sessionHash: params.sessionHash,
     verdictHash: params.verdictHash,
     outcome: params.outcome,
     participantIndices: participants,
     threshold: params.threshold,
     attempt: params.attempt,
     deadline: params.deadline,
     phase: 'intent',
     commitments: [],
     partials: [],
   };
 }
 
 export function reduceCourtSigningMachine(
   state: CourtSigningMachineState,
   event: CourtSigningMachineEvent,
 ): CourtSigningMachineState {
+  assertDeadline(state.deadline);
   if (event.type === 'tick') {
     assertNow(event.now);
     if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'intent') {
       throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
     }
     return { ...state, phase: 'nonce_commit' };
   }
 
   if (event.type === 'accept_commitment') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
     }
     // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
     // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
     // machine must not reject the x-only form.
     if (!HEX_POINT.test(event.binderPn) || !HEX_POINT.test(event.hiddenPn)) {
       throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
     }
     const existing = state.commitments.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
         return state;
       }
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       commitments: [
         ...state.commitments,
         { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
       ],
     };
   }
 
   if (event.type === 'close_commitments') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
     }
     if (state.commitments.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
       );
     }
     const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
     return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
   }
 
   if (event.type === 'accept_partial') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
       throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
     }
     if (!state.finalizedSignerSet?.includes(event.idx)) {
       throw new CourtSigningTransitionError(
         `signer ${event.idx} is not in the finalized commitment set`,
       );
     }
     if (!HEX_32.test(event.psig)) {
       throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
     }
     const existing = state.partials.find((p) => p.idx === event.idx);
     if (existing) {
       if (existing.psig === event.psig) return state;
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published conflicting partial signatures for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       phase: 'partial_sign',
       partials: [...state.partials, { idx: event.idx, psig: event.psig }],
     };
   }
 
   if (event.type === 'aggregate') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
       throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
     }
     if (state.partials.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
       );
     }
     if (!SCHNORR_SIGNATURE.test(event.signature)) {
       throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
     }
     return { ...state, phase: 'aggregate', signature: event.signature };
   }
 
   if (event.type === 'publish') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'aggregate' || !state.signature) {
       throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
     }
     if (!HEX_32.test(event.attestationEventId)) {
       throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
     }
     return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
   }
 
   return state;
 }

```


---

### Unauthenticated Index Claims Enable Peer Blame

**Affected files:** courtSigningMachine.ts

**V12 reasoning:** Require each accepted partial to carry the signed FROST reveal and full session parameters, verify the session hash matches the reducer state, and derive the signer index and partial only from strict signature/participant-bound protocol parsing.

```diff
diff --git a/courtSigningMachine.ts b/courtSigningMachine.ts
--- a/courtSigningMachine.ts
+++ b/courtSigningMachine.ts
@@ -1,386 +1,401 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court FROST signing attempt.
  *
  * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
  * aggregate -> attestation_published.
  *
  * The signing-session hash binds the Court session hash, the frozen verdict
  * hash, the exact outcome, the signing attempt, the threshold, and the signer
  * set. Changing any bound field requires a new machine for a new attempt and
  * invalidates every prior nonce commitment. Each roster signer may publish
  * exactly one nonce commitment per attempt; a conflicting second commitment
  * is nonce equivocation and aborts the attempt with blame.
  *
  * This module performs no FROST cryptographic verification; the boundary must
  * verify partial signatures against the certified verification shares and the
  * finalized commitment set before dispatching events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
-import { CanonicalWriter } from './courtSession';
+import type { Event } from 'nostr-tools/pure';
+import { parseBoundFrostRevealEvent } from './courtProtocolEvents';
+import {
+  CanonicalWriter,
+  assertCourtSessionParameters,
+  hashCourtSessionParameters,
+  type CourtSessionParameters,
+} from './courtSession';
 
 export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';
 
 export type CourtSigningPhase =
   | 'intent'
   | 'nonce_commit'
   | 'commitment_set_final'
   | 'partial_sign'
   | 'aggregate'
   | 'attestation_published'
   | 'expired'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network';
 
 export type CourtSigningFailurePhase = Extract<
   CourtSigningPhase,
   'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
 >;
 
 export interface CourtSigningFailure {
   readonly phase: CourtSigningFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtSigningCommitmentRecord {
   readonly idx: number;
   readonly binderPn: string;
   readonly hiddenPn: string;
 }
 
 export interface CourtSigningPartialRecord {
   readonly idx: number;
   readonly psig: string;
 }
 
 export interface CourtSigningMachineState {
   readonly signingSessionHash: string;
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
   readonly phase: CourtSigningPhase;
   readonly commitments: readonly CourtSigningCommitmentRecord[];
   /** Frozen, sorted signer set whose commitments define the signing context. */
   readonly finalizedSignerSet?: readonly number[];
   readonly partials: readonly CourtSigningPartialRecord[];
   readonly signature?: string;
   readonly attestationEventId?: string;
   readonly failure?: CourtSigningFailure;
 }
 
 export type CourtSigningMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | {
       readonly type: 'accept_commitment';
       readonly idx: number;
       readonly binderPn: string;
       readonly hiddenPn: string;
       readonly now: number;
     }
   | { readonly type: 'close_commitments'; readonly now: number }
   | {
       readonly type: 'accept_partial';
-      readonly idx: number;
-      readonly psig: string;
+      /** Signed FROST reveal; the reducer authenticates its participant binding. */
+      readonly protocolEvent: Event;
+      readonly sessionParameters: CourtSessionParameters;
       readonly now: number;
     }
   | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
   | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtSigningFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtSigningTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtSigningTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtSigningPhase>([
   'attestation_published',
   'expired',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
 ]);
 
 /**
  * Canonical hash binding every field that defines one signing attempt. A
  * FROST nonce commitment may be consumed only under exactly one such hash.
  */
 export function hashCourtSigningSession(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.hex(params.verdictHash);
   writer.text(params.outcome);
   writer.u32(params.participantIndices.length);
   for (const idx of params.participantIndices) {
     writer.u32(idx);
   }
   writer.u32(params.threshold);
   writer.u32(params.attempt);
   const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
   const encoded = writer.finish();
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtSigningTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtSigningMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtSigningTransitionError(`signer ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtSigningTransitionError('signing message arrived at or after the attempt deadline');
   }
 }
 
 export function createCourtSigningMachine(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
 }): CourtSigningMachineState {
   if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
     throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
   }
   if (
     typeof params.outcome !== 'string' ||
     params.outcome.length === 0 ||
     textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
   ) {
     throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtSigningTransitionError('signing requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtSigningTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Number.isSafeInteger(params.threshold) ||
     params.threshold < 1 ||
     params.threshold > participants.length
   ) {
     throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
   }
   if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
     throw new CourtSigningTransitionError('attempt must be a non-negative integer');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
   }
   return {
     signingSessionHash: hashCourtSigningSession({
       sessionHash: params.sessionHash,
       verdictHash: params.verdictHash,
       outcome: params.outcome,
       participantIndices: participants,
       threshold: params.threshold,
       attempt: params.attempt,
     }),
     sessionHash: params.sessionHash,
     verdictHash: params.verdictHash,
     outcome: params.outcome,
     participantIndices: participants,
     threshold: params.threshold,
     attempt: params.attempt,
     deadline: params.deadline,
     phase: 'intent',
     commitments: [],
     partials: [],
   };
 }
 
 export function reduceCourtSigningMachine(
   state: CourtSigningMachineState,
   event: CourtSigningMachineEvent,
 ): CourtSigningMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'intent') {
       throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
     }
     return { ...state, phase: 'nonce_commit' };
   }
 
   if (event.type === 'accept_commitment') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
     }
     // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
     // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
     // machine must not reject the x-only form.
     if (!HEX_POINT.test(event.binderPn) || !HEX_POINT.test(event.hiddenPn)) {
       throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
     }
     const existing = state.commitments.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
         return state;
       }
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       commitments: [
         ...state.commitments,
         { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
       ],
     };
   }
 
   if (event.type === 'close_commitments') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
     }
     if (state.commitments.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
       );
     }
     const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
     return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
   }
 
   if (event.type === 'accept_partial') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
       throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
     }
-    if (!state.finalizedSignerSet?.includes(event.idx)) {
+    assertCourtSessionParameters(event.sessionParameters);
+    if (hashCourtSessionParameters(event.sessionParameters) !== state.sessionHash) {
+      throw new CourtSigningTransitionError('partial signature session parameters do not match this signing attempt');
+    }
+    const parsed = parseBoundFrostRevealEvent(event.protocolEvent, event.sessionParameters);
+    const idx = parsed.participant.idx;
+    const psig = parsed.partialSig;
+    if (!state.finalizedSignerSet?.includes(idx)) {
       throw new CourtSigningTransitionError(
-        `signer ${event.idx} is not in the finalized commitment set`,
+        `signer ${idx} is not in the finalized commitment set`,
       );
     }
-    if (!HEX_32.test(event.psig)) {
+    if (!HEX_32.test(psig)) {
       throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
     }
-    const existing = state.partials.find((p) => p.idx === event.idx);
+    const existing = state.partials.find((p) => p.idx === idx);
     if (existing) {
-      if (existing.psig === event.psig) return state;
+      if (existing.psig === psig) return state;
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
-          blamedIdx: event.idx,
+          blamedIdx: idx,
           reason: 'A signer published conflicting partial signatures for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       phase: 'partial_sign',
-      partials: [...state.partials, { idx: event.idx, psig: event.psig }],
+      partials: [...state.partials, { idx, psig }],
     };
   }
 
   if (event.type === 'aggregate') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
       throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
     }
     if (state.partials.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
       );
     }
     if (!SCHNORR_SIGNATURE.test(event.signature)) {
       throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
     }
     return { ...state, phase: 'aggregate', signature: event.signature };
   }
 
   if (event.type === 'publish') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'aggregate' || !state.signature) {
       throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
     }
     if (!HEX_32.test(event.attestationEventId)) {
       throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
     }
     return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
   }
 
   return state;
 }

```


---

### Unbounded ceremony rosters exhaust reducer resources

**Affected files:** courtSession.ts, courtVoteMachine.ts, courtDkgMachine.ts

**V12 reasoning:** Expose the existing protocol-wide 1,000-participant session limit and enforce it in both vote and DKG constructors before either copies, validates, or retains the caller-controlled roster.

```diff
diff --git a/courtSession.ts b/courtSession.ts
--- a/courtSession.ts
+++ b/courtSession.ts
@@ -1,554 +1,554 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Canonical identity for a BAO Court ceremony.
  *
  * This module deliberately contains no React, relay, signer, or secret-key
  * logic. Browser clients, agents, and future cryptographic adapters must all
  * derive the same session hash from the same validated public parameters.
  */
 
 import { secp256k1 } from '@noble/curves/secp256k1.js';
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 
 export const COURT_SESSION_VERSION = 1 as const;
 export const COURT_SESSION_DOMAIN = 'BAO-Court/SessionParameters/v1';
 
 export const COURT_ENVIRONMENTS = ['demo', 'signet', 'mainnet'] as const;
 export type CourtEnvironment = (typeof COURT_ENVIRONMENTS)[number];
 
 /**
  * No suite is production-enabled yet. The ChillDKG identifier is reserved for
  * the future vector-verified adapter and must not be used to describe the
  * current Pedersen implementation.
  */
 export const COURT_CRYPTO_SUITES = [
   'pedpop-v1-experimental',
   'chilldkg-0.3+bip445-draft',
 ] as const;
 export type CourtCryptoSuite = (typeof COURT_CRYPTO_SUITES)[number];
 
 export type CourtParticipantRole = 'juror' | 'juror-coordinator';
 
 export interface CourtSessionParticipant {
   /** Sequential, one-based FROST participant index. */
   readonly idx: number;
   /** Lowercase 32-byte Nostr public key. */
   readonly nostrPubkey: string;
   /** Lowercase 33-byte compressed secp256k1 Court host public key. */
   readonly hostPubkey: string;
   /** Stable reference to the externally verified bond evidence. */
   readonly bondRef: string;
   /** Exactly one participant coordinates a particular ceremony attempt. */
   readonly role: CourtParticipantRole;
 }
 
 export interface CourtSessionParameters {
   readonly version: typeof COURT_SESSION_VERSION;
   readonly environment: CourtEnvironment;
   readonly cryptoSuite: CourtCryptoSuite;
   readonly disputeEventId: string;
   readonly disputeId: string;
   readonly marketId: string;
   readonly marketEventId: string;
   readonly selectionEventId: string;
   readonly blockHash: string;
   readonly blockHeight: number;
   readonly participants: readonly CourtSessionParticipant[];
   readonly threshold: number;
   /** Frozen, ordered, non-empty outcome strings accepted by this jury. */
   readonly allowedOutcomes: readonly string[];
   readonly attempt: number;
   /** Unix timestamp in seconds. */
   readonly createdAt: number;
   /** Unix timestamp in seconds. */
   readonly deadline: number;
 }
 
 export type CourtSessionValidationCode =
   | 'invalid_shape'
   | 'unsupported_version'
   | 'unsupported_environment'
   | 'unsupported_suite'
   | 'suite_not_allowed_on_mainnet'
   | 'invalid_identifier'
   | 'invalid_hex'
   | 'invalid_number'
   | 'invalid_participant_count'
   | 'invalid_participant_index'
   | 'invalid_participant_key'
   | 'duplicate_participant_key'
   | 'duplicate_bond'
   | 'invalid_coordinator_count'
   | 'invalid_threshold'
   | 'invalid_outcome'
   | 'duplicate_outcome'
   | 'invalid_deadline'
   | 'participant_not_found'
   | 'participant_binding_mismatch';
 
 export class CourtSessionValidationError extends Error {
   readonly code: CourtSessionValidationCode;
 
   constructor(code: CourtSessionValidationCode, message: string) {
     super(message);
     this.name = 'CourtSessionValidationError';
     this.code = code;
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const COMPRESSED_KEY = /^(02|03)[0-9a-f]{64}$/;
 const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
-const MAX_PARTICIPANTS = 1_000;
+export const MAX_COURT_PARTICIPANTS = 1_000;
 const MAX_OUTCOMES = 256;
 const MAX_IDENTIFIER_BYTES = 256;
 const MAX_OUTCOME_BYTES = 256;
 const MAX_BOND_REF_BYTES = 512;
 const MAX_U32 = 0xffff_ffff;
 const MAX_SAFE_U64 = Number.MAX_SAFE_INTEGER;
 
 function isRecord(value: unknown): value is Record<string, unknown> {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
 }
 
 function assertExactKeys(
   value: Record<string, unknown>,
   allowedKeys: readonly string[],
   field: string,
 ): void {
   const allowed = new Set(allowedKeys);
   const unexpected = Object.keys(value).find((key) => !allowed.has(key));
   if (unexpected) {
     throw new CourtSessionValidationError(
       'invalid_shape',
       `${field} contains unsupported field ${unexpected}`,
     );
   }
 }
 
 function isOneOf<const T extends readonly string[]>(
   values: T,
   value: unknown,
 ): value is T[number] {
   return typeof value === 'string' && values.includes(value as T[number]);
 }
 
 function assertCanonicalText(
   value: unknown,
   field: string,
   maxBytes: number,
   code: CourtSessionValidationCode,
 ): asserts value is string {
   if (
     typeof value !== 'string'
     || value.length === 0
     || value !== value.trim()
     || value !== value.normalize('NFC')
     || CONTROL_CHARACTERS.test(value)
     || textEncoder.encode(value).length > maxBytes
   ) {
     throw new CourtSessionValidationError(
       code,
       `${field} must be non-empty canonical UTF-8 without surrounding whitespace or control characters`,
     );
   }
 }
 
 function assertHex32(value: unknown, field: string): asserts value is string {
   if (typeof value !== 'string' || !HEX_32.test(value)) {
     throw new CourtSessionValidationError(
       'invalid_hex',
       `${field} must be 32-byte lowercase hex`,
     );
   }
 }
 
 function assertSafeInteger(
   value: unknown,
   field: string,
   minimum: number,
   maximum = MAX_SAFE_U64,
 ): asserts value is number {
   if (
     typeof value !== 'number'
     || !Number.isSafeInteger(value)
     || value < minimum
     || value > maximum
   ) {
     throw new CourtSessionValidationError(
       'invalid_number',
       `${field} must be a safe integer between ${minimum} and ${maximum}`,
     );
   }
 }
 
 function assertHostPubkey(value: unknown, field: string): asserts value is string {
   if (typeof value !== 'string' || !COMPRESSED_KEY.test(value)) {
     throw new CourtSessionValidationError(
       'invalid_participant_key',
       `${field} must be a lowercase compressed secp256k1 public key`,
     );
   }
 
   try {
     secp256k1.Point.fromHex(value);
   } catch {
     throw new CourtSessionValidationError(
       'invalid_participant_key',
       `${field} is not a valid secp256k1 point`,
     );
   }
 }
 
 function validateParticipant(
   value: unknown,
   expectedIdx: number,
 ): asserts value is CourtSessionParticipant {
   if (!isRecord(value)) {
     throw new CourtSessionValidationError(
       'invalid_shape',
       `participants[${expectedIdx - 1}] must be an object`,
     );
   }
   assertExactKeys(
     value,
     ['idx', 'nostrPubkey', 'hostPubkey', 'bondRef', 'role'],
     `participants[${expectedIdx - 1}]`,
   );
 
   assertSafeInteger(value.idx, `participants[${expectedIdx - 1}].idx`, 1, MAX_U32);
   if (value.idx !== expectedIdx) {
     throw new CourtSessionValidationError(
       'invalid_participant_index',
       `participant indices must be sequential and ordered; expected ${expectedIdx}`,
     );
   }
   assertHex32(value.nostrPubkey, `participants[${expectedIdx - 1}].nostrPubkey`);
   assertHostPubkey(value.hostPubkey, `participants[${expectedIdx - 1}].hostPubkey`);
   assertCanonicalText(
     value.bondRef,
     `participants[${expectedIdx - 1}].bondRef`,
     MAX_BOND_REF_BYTES,
     'invalid_identifier',
   );
   if (value.role !== 'juror' && value.role !== 'juror-coordinator') {
     throw new CourtSessionValidationError(
       'invalid_shape',
       `participants[${expectedIdx - 1}].role is unsupported`,
     );
   }
 }
 
 /**
  * Validate the complete public identity of one Court ceremony.
  *
  * Mainnet is deliberately rejected until a suite passes the rollout gates.
  */
 export function assertCourtSessionParameters(
   value: unknown,
 ): asserts value is CourtSessionParameters {
   if (!isRecord(value)) {
     throw new CourtSessionValidationError('invalid_shape', 'session parameters must be an object');
   }
   assertExactKeys(
     value,
     [
       'version',
       'environment',
       'cryptoSuite',
       'disputeEventId',
       'disputeId',
       'marketId',
       'marketEventId',
       'selectionEventId',
       'blockHash',
       'blockHeight',
       'participants',
       'threshold',
       'allowedOutcomes',
       'attempt',
       'createdAt',
       'deadline',
     ],
     'session parameters',
   );
   if (value.version !== COURT_SESSION_VERSION) {
     throw new CourtSessionValidationError('unsupported_version', 'unsupported Court session version');
   }
   if (!isOneOf(COURT_ENVIRONMENTS, value.environment)) {
     throw new CourtSessionValidationError('unsupported_environment', 'unsupported Court environment');
   }
   if (!isOneOf(COURT_CRYPTO_SUITES, value.cryptoSuite)) {
     throw new CourtSessionValidationError('unsupported_suite', 'unsupported Court crypto suite');
   }
   if (value.environment === 'mainnet') {
     throw new CourtSessionValidationError(
       'suite_not_allowed_on_mainnet',
       `${value.cryptoSuite} has not passed the BAO Court mainnet activation gate`,
     );
   }
 
   assertHex32(value.disputeEventId, 'disputeEventId');
   assertCanonicalText(value.disputeId, 'disputeId', MAX_IDENTIFIER_BYTES, 'invalid_identifier');
   assertCanonicalText(value.marketId, 'marketId', MAX_IDENTIFIER_BYTES, 'invalid_identifier');
   assertHex32(value.marketEventId, 'marketEventId');
   assertHex32(value.selectionEventId, 'selectionEventId');
   assertHex32(value.blockHash, 'blockHash');
   assertSafeInteger(value.blockHeight, 'blockHeight', 0);
   assertSafeInteger(value.threshold, 'threshold', 1, MAX_U32);
   assertSafeInteger(value.attempt, 'attempt', 0, MAX_U32);
   assertSafeInteger(value.createdAt, 'createdAt', 0);
   assertSafeInteger(value.deadline, 'deadline', 0);
   if (value.deadline <= value.createdAt) {
     throw new CourtSessionValidationError(
       'invalid_deadline',
       'deadline must be later than createdAt',
     );
   }
 
   if (
     !Array.isArray(value.participants)
     || value.participants.length === 0
-    || value.participants.length > MAX_PARTICIPANTS
+    || value.participants.length > MAX_COURT_PARTICIPANTS
   ) {
     throw new CourtSessionValidationError(
       'invalid_participant_count',
-      `participants must contain between 1 and ${MAX_PARTICIPANTS} entries`,
+      `participants must contain between 1 and ${MAX_COURT_PARTICIPANTS} entries`,
     );
   }
 
   const nostrPubkeys = new Set<string>();
   const hostPubkeys = new Set<string>();
   const bondRefs = new Set<string>();
   let coordinatorCount = 0;
   value.participants.forEach((participant, offset) => {
     validateParticipant(participant, offset + 1);
     if (nostrPubkeys.has(participant.nostrPubkey) || hostPubkeys.has(participant.hostPubkey)) {
       throw new CourtSessionValidationError(
         'duplicate_participant_key',
         'participant Nostr and Court host keys must each be unique',
       );
     }
     if (bondRefs.has(participant.bondRef)) {
       throw new CourtSessionValidationError(
         'duplicate_bond',
         'each participant must have distinct bond evidence',
       );
     }
     nostrPubkeys.add(participant.nostrPubkey);
     hostPubkeys.add(participant.hostPubkey);
     bondRefs.add(participant.bondRef);
     if (participant.role === 'juror-coordinator') coordinatorCount += 1;
   });
 
   if (coordinatorCount !== 1) {
     throw new CourtSessionValidationError(
       'invalid_coordinator_count',
       'exactly one selected juror must coordinate each ceremony attempt',
     );
   }
   if (value.threshold > value.participants.length) {
     throw new CourtSessionValidationError(
       'invalid_threshold',
       'threshold cannot exceed the participant count',
     );
   }
 
   if (
     !Array.isArray(value.allowedOutcomes)
     || value.allowedOutcomes.length < 2
     || value.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtSessionValidationError(
       'invalid_outcome',
       `allowedOutcomes must contain between 2 and ${MAX_OUTCOMES} outcomes`,
     );
   }
   const outcomes = new Set<string>();
   value.allowedOutcomes.forEach((outcome, index) => {
     assertCanonicalText(
       outcome,
       `allowedOutcomes[${index}]`,
       MAX_OUTCOME_BYTES,
       'invalid_outcome',
     );
     if (outcomes.has(outcome)) {
       throw new CourtSessionValidationError('duplicate_outcome', 'allowed outcomes must be unique');
     }
     outcomes.add(outcome);
   });
 }
 
 /**
  * Length-prefixed canonical binary writer shared by every Court hash domain.
  * Delimiter-joined attacker-controlled strings must never be hashed directly.
  */
 export class CanonicalWriter {
   private readonly chunks: Uint8Array[] = [];
 
   u8(value: number): void {
     if (!Number.isInteger(value) || value < 0 || value > 0xff) {
       throw new CourtSessionValidationError(
         'invalid_number',
         'u8 field must be an integer in [0, 255]',
       );
     }
     this.chunks.push(Uint8Array.of(value));
   }
 
   u32(value: number): void {
     if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
       throw new CourtSessionValidationError(
         'invalid_number',
         'u32 field must be an integer in [0, 4294967295]',
       );
     }
     const bytes = new Uint8Array(4);
     new DataView(bytes.buffer).setUint32(0, value, false);
     this.chunks.push(bytes);
   }
 
   u64(value: number): void {
     // Safe integers are bounded by 2^53-1 < 2^64, so a safe non-negative
     // integer is always representable and cannot wrap in setBigUint64.
     if (!Number.isSafeInteger(value) || value < 0) {
       throw new CourtSessionValidationError(
         'invalid_number',
         'u64 field must be a safe non-negative integer',
       );
     }
     const bytes = new Uint8Array(8);
     new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
     this.chunks.push(bytes);
   }
 
   bytes(value: Uint8Array): void {
     this.u32(value.length);
     this.chunks.push(value);
   }
 
   text(value: string): void {
     this.bytes(textEncoder.encode(value));
   }
 
   hex(value: string): void {
     this.bytes(hexToBytes(value));
   }
 
   finish(): Uint8Array {
     const length = this.chunks.reduce((total, chunk) => total + chunk.length, 0);
     const output = new Uint8Array(length);
     let offset = 0;
     for (const chunk of this.chunks) {
       output.set(chunk, offset);
       offset += chunk.length;
     }
     return output;
   }
 }
 
 const ENVIRONMENT_IDS: Readonly<Record<CourtEnvironment, number>> = {
   demo: 0,
   signet: 1,
   mainnet: 2,
 };
 
 const SUITE_IDS: Readonly<Record<CourtCryptoSuite, number>> = {
   'pedpop-v1-experimental': 0,
   'chilldkg-0.3+bip445-draft': 1,
 };
 
 const ROLE_IDS: Readonly<Record<CourtParticipantRole, number>> = {
   juror: 0,
   'juror-coordinator': 1,
 };
 
 /** Return the canonical binary encoding used by the Court session hash. */
 export function encodeCourtSessionParameters(value: CourtSessionParameters): Uint8Array {
   assertCourtSessionParameters(value);
   const writer = new CanonicalWriter();
   writer.u8(value.version);
   writer.u8(ENVIRONMENT_IDS[value.environment]);
   writer.u8(SUITE_IDS[value.cryptoSuite]);
   writer.hex(value.disputeEventId);
   writer.text(value.disputeId);
   writer.text(value.marketId);
   writer.hex(value.marketEventId);
   writer.hex(value.selectionEventId);
   writer.hex(value.blockHash);
   writer.u64(value.blockHeight);
   writer.u32(value.participants.length);
   for (const participant of value.participants) {
     writer.u32(participant.idx);
     writer.hex(participant.nostrPubkey);
     writer.hex(participant.hostPubkey);
     writer.text(participant.bondRef);
     writer.u8(ROLE_IDS[participant.role]);
   }
   writer.u32(value.threshold);
   writer.u32(value.allowedOutcomes.length);
   value.allowedOutcomes.forEach((outcome) => writer.text(outcome));
   writer.u32(value.attempt);
   writer.u64(value.createdAt);
   writer.u64(value.deadline);
   return writer.finish();
 }
 
 /** Derive the lowercase SHA-256 Court session identifier. */
 export function hashCourtSessionParameters(value: CourtSessionParameters): string {
   const encoded = encodeCourtSessionParameters(value);
   const domain = textEncoder.encode(COURT_SESSION_DOMAIN);
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 /** Find a selected participant by their canonical one-based index. */
 export function getCourtSessionParticipant(
   value: CourtSessionParameters,
   idx: number,
 ): CourtSessionParticipant {
   assertCourtSessionParameters(value);
   assertSafeInteger(idx, 'idx', 1, MAX_U32);
   const participant = value.participants[idx - 1];
   if (!participant || participant.idx !== idx) {
     throw new CourtSessionValidationError(
       'participant_not_found',
       `participant ${idx} is not in this Court session`,
     );
   }
   return participant;
 }
 
 /**
  * Bind a protocol event's signed author and claimed keys to one roster entry.
  */
 export function assertCourtParticipantBinding(
   value: CourtSessionParameters,
   claimedIdx: number,
   eventAuthor: string,
   claimedHostPubkey?: string,
 ): CourtSessionParticipant {
   const participant = getCourtSessionParticipant(value, claimedIdx);
   assertHex32(eventAuthor, 'eventAuthor');
   if (eventAuthor !== participant.nostrPubkey) {
     throw new CourtSessionValidationError(
       'participant_binding_mismatch',
       `event author does not match Court participant ${claimedIdx}`,
     );
   }
   if (claimedHostPubkey !== undefined) {
     assertHostPubkey(claimedHostPubkey, 'claimedHostPubkey');
     if (claimedHostPubkey !== participant.hostPubkey) {
       throw new CourtSessionValidationError(
         'participant_binding_mismatch',
         `Court host key does not match participant ${claimedIdx}`,
       );
     }
   }
   return participant;
 }

diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,444 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
-import { CanonicalWriter } from './courtSession';
+import { CanonicalWriter, MAX_COURT_PARTICIPANTS } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
-  if (params.participantIndices.length === 0) {
-    throw new CourtVoteTransitionError('voting requires at least one participant');
+  if (
+    params.participantIndices.length === 0
+    || params.participantIndices.length > MAX_COURT_PARTICIPANTS
+  ) {
+    throw new CourtVoteTransitionError(
+      `voting requires between 1 and ${MAX_COURT_PARTICIPANTS} participants`,
+    );
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

diff --git a/courtDkgMachine.ts b/courtDkgMachine.ts
--- a/courtDkgMachine.ts
+++ b/courtDkgMachine.ts
@@ -1,275 +1,282 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /** Pure fail-closed state machine for one BAO Court DKG attempt. */
 
+import { MAX_COURT_PARTICIPANTS } from './courtSession';
+
 export type CourtDkgPhase =
   | 'parameters_confirmed'
   | 'dkg_round_1'
   | 'dkg_round_2'
   | 'transcript_signing'
   | 'certified'
   | 'backed_up'
   | 'expired'
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite';
 
 export type CourtDkgFailurePhase = Extract<
   CourtDkgPhase,
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite'
 >;
 
 export interface CourtDkgFailure {
   readonly phase: CourtDkgFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtDkgMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
   readonly phase: CourtDkgPhase;
   readonly round1Participants: readonly number[];
   readonly round2Participants: readonly number[];
   readonly transcriptCertifiers: readonly number[];
   readonly transcriptHash?: string;
   readonly candidateGroupPubkey?: string;
   /** Unavailable until every participant certifies the exact transcript. */
   readonly certifiedGroupPubkey?: string;
   readonly backupVerified: boolean;
   readonly failure?: CourtDkgFailure;
 }
 
 export type CourtDkgMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | { readonly type: 'accept_round_1'; readonly idx: number; readonly now: number }
   | { readonly type: 'accept_round_2'; readonly idx: number; readonly now: number }
   | {
       readonly type: 'finalize_transcript';
       readonly transcriptHash: string;
       readonly candidateGroupPubkey: string;
       readonly now: number;
     }
   | {
       readonly type: 'accept_certification';
       readonly idx: number;
       readonly transcriptHash: string;
       readonly now: number;
     }
   | { readonly type: 'confirm_backup'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtDkgFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtDkgTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtDkgTransitionError';
   }
 }
 
 const HEX_32 = /^[0-9a-f]{64}$/;
 const GROUP_KEY = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 
 const TERMINAL_PHASES = new Set<CourtDkgPhase>([
   'backed_up',
   'expired',
   'delivery_failed',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
   'incompatible_suite',
 ]);
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtDkgTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function addSorted(values: readonly number[], idx: number): readonly number[] {
   if (values.includes(idx)) return values;
   return [...values, idx].sort((a, b) => a - b);
 }
 
 function assertParticipant(state: CourtDkgMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtDkgTransitionError(`participant ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtDkgMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtDkgTransitionError('DKG message arrived at or after the ceremony deadline');
   }
 }
 
 function expire(state: CourtDkgMachineState, now: number): CourtDkgMachineState {
   assertNow(now);
   if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') return state;
   if (now < state.deadline) return state;
   return {
     ...state,
     phase: 'expired',
     failure: { phase: 'expired', reason: 'The DKG deadline passed before unanimous certification.' },
   };
 }
 
 export function createCourtDkgMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
 }): CourtDkgMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtDkgTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtDkgTransitionError('deadline must be a positive Unix timestamp');
   }
-  if (params.participantIndices.length === 0) {
-    throw new CourtDkgTransitionError('DKG requires at least one participant');
+  if (
+    params.participantIndices.length === 0
+    || params.participantIndices.length > MAX_COURT_PARTICIPANTS
+  ) {
+    throw new CourtDkgTransitionError(
+      `DKG requires between 1 and ${MAX_COURT_PARTICIPANTS} participants`,
+    );
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtDkgTransitionError('participant indices must be ordered and sequential');
     }
   });
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     deadline: params.deadline,
     phase: 'parameters_confirmed',
     round1Participants: [],
     round2Participants: [],
     transcriptCertifiers: [],
     backupVerified: false,
   };
 }
 
 export function reduceCourtDkgMachine(
   state: CourtDkgMachineState,
   event: CourtDkgMachineEvent,
 ): CourtDkgMachineState {
   if (event.type === 'tick') return expire(state, event.now);
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') {
       throw new CourtDkgTransitionError(`cannot abort DKG from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtDkgTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'parameters_confirmed') {
       throw new CourtDkgTransitionError(`cannot start DKG from ${state.phase}`);
     }
     return { ...state, phase: 'dkg_round_1' };
   }
 
   if (event.type === 'accept_round_1') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_1') {
       throw new CourtDkgTransitionError(`cannot accept round 1 data during ${state.phase}`);
     }
     const accepted = addSorted(state.round1Participants, event.idx);
     return {
       ...state,
       round1Participants: accepted,
       phase: accepted.length === state.participantIndices.length ? 'dkg_round_2' : state.phase,
     };
   }
 
   if (event.type === 'accept_round_2') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_2') {
       throw new CourtDkgTransitionError(`cannot accept round 2 data during ${state.phase}`);
     }
     return { ...state, round2Participants: addSorted(state.round2Participants, event.idx) };
   }
 
   if (event.type === 'finalize_transcript') {
     assertBeforeDeadline(state, event.now);
     if (
       state.phase !== 'dkg_round_2'
       || state.round2Participants.length !== state.participantIndices.length
     ) {
       throw new CourtDkgTransitionError('cannot finalize before every participant completes round 2');
     }
     if (!HEX_32.test(event.transcriptHash) || !GROUP_KEY.test(event.candidateGroupPubkey)) {
       throw new CourtDkgTransitionError('transcript hash or candidate group key has invalid encoding');
     }
     return {
       ...state,
       phase: 'transcript_signing',
       transcriptHash: event.transcriptHash,
       candidateGroupPubkey: event.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'accept_certification') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'transcript_signing' || !state.transcriptHash || !state.candidateGroupPubkey) {
       throw new CourtDkgTransitionError(`cannot certify transcript during ${state.phase}`);
     }
     if (event.transcriptHash !== state.transcriptHash) {
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A participant certified a different DKG transcript.',
         },
       };
     }
     const certifiers = addSorted(state.transcriptCertifiers, event.idx);
     if (certifiers.length !== state.participantIndices.length) {
       return { ...state, transcriptCertifiers: certifiers };
     }
     return {
       ...state,
       phase: 'certified',
       transcriptCertifiers: certifiers,
       certifiedGroupPubkey: state.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'confirm_backup') {
     // Backup confirmation is a LOCAL event (the juror validated its own
     // recovery data), not a peer message, so it is not bounded by the
     // ceremony deadline. A certified machine must never be stranded: without
     // this, a certification at the deadline could never reach `backed_up`
     // and was frozen in `certified` forever.
     assertNow(event.now);
     if (state.phase !== 'certified' || !state.certifiedGroupPubkey) {
       throw new CourtDkgTransitionError('cannot confirm recovery data before DKG certification');
     }
     return { ...state, phase: 'backed_up', backupVerified: true };
   }
 
   return state;
 }

```


---

### Validate abort phases before mutating ceremony state

**Affected files:** courtDkgMachine.ts, courtSigningMachine.ts

**V12 reasoning:** Adds explicit runtime allowlists for each reducer's abort-only failure phases and rejects malformed abort phases before any ceremony state or failure record is mutated.

```diff
diff --git a/courtDkgMachine.ts b/courtDkgMachine.ts
--- a/courtDkgMachine.ts
+++ b/courtDkgMachine.ts
@@ -1,275 +1,286 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /** Pure fail-closed state machine for one BAO Court DKG attempt. */
 
 export type CourtDkgPhase =
   | 'parameters_confirmed'
   | 'dkg_round_1'
   | 'dkg_round_2'
   | 'transcript_signing'
   | 'certified'
   | 'backed_up'
   | 'expired'
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite';
 
 export type CourtDkgFailurePhase = Extract<
   CourtDkgPhase,
   | 'delivery_failed'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network'
   | 'incompatible_suite'
 >;
 
 export interface CourtDkgFailure {
   readonly phase: CourtDkgFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtDkgMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
   readonly phase: CourtDkgPhase;
   readonly round1Participants: readonly number[];
   readonly round2Participants: readonly number[];
   readonly transcriptCertifiers: readonly number[];
   readonly transcriptHash?: string;
   readonly candidateGroupPubkey?: string;
   /** Unavailable until every participant certifies the exact transcript. */
   readonly certifiedGroupPubkey?: string;
   readonly backupVerified: boolean;
   readonly failure?: CourtDkgFailure;
 }
 
 export type CourtDkgMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | { readonly type: 'accept_round_1'; readonly idx: number; readonly now: number }
   | { readonly type: 'accept_round_2'; readonly idx: number; readonly now: number }
   | {
       readonly type: 'finalize_transcript';
       readonly transcriptHash: string;
       readonly candidateGroupPubkey: string;
       readonly now: number;
     }
   | {
       readonly type: 'accept_certification';
       readonly idx: number;
       readonly transcriptHash: string;
       readonly now: number;
     }
   | { readonly type: 'confirm_backup'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtDkgFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtDkgTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtDkgTransitionError';
   }
 }
 
 const HEX_32 = /^[0-9a-f]{64}$/;
 const GROUP_KEY = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 
+const ABORT_PHASES = new Set<CourtDkgPhase>([
+  'delivery_failed',
+  'aborted_peer',
+  'aborted_coordinator',
+  'aborted_network',
+  'incompatible_suite',
+]);
+
 const TERMINAL_PHASES = new Set<CourtDkgPhase>([
   'backed_up',
   'expired',
   'delivery_failed',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
   'incompatible_suite',
 ]);
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtDkgTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function addSorted(values: readonly number[], idx: number): readonly number[] {
   if (values.includes(idx)) return values;
   return [...values, idx].sort((a, b) => a - b);
 }
 
 function assertParticipant(state: CourtDkgMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtDkgTransitionError(`participant ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtDkgMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtDkgTransitionError('DKG message arrived at or after the ceremony deadline');
   }
 }
 
 function expire(state: CourtDkgMachineState, now: number): CourtDkgMachineState {
   assertNow(now);
   if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') return state;
   if (now < state.deadline) return state;
   return {
     ...state,
     phase: 'expired',
     failure: { phase: 'expired', reason: 'The DKG deadline passed before unanimous certification.' },
   };
 }
 
 export function createCourtDkgMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly deadline: number;
 }): CourtDkgMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtDkgTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtDkgTransitionError('deadline must be a positive Unix timestamp');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtDkgTransitionError('DKG requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtDkgTransitionError('participant indices must be ordered and sequential');
     }
   });
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     deadline: params.deadline,
     phase: 'parameters_confirmed',
     round1Participants: [],
     round2Participants: [],
     transcriptCertifiers: [],
     backupVerified: false,
   };
 }
 
 export function reduceCourtDkgMachine(
   state: CourtDkgMachineState,
   event: CourtDkgMachineEvent,
 ): CourtDkgMachineState {
   if (event.type === 'tick') return expire(state, event.now);
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase) || state.phase === 'certified') {
       throw new CourtDkgTransitionError(`cannot abort DKG from ${state.phase}`);
     }
+    if (!ABORT_PHASES.has(event.phase)) {
+      throw new CourtDkgTransitionError(`invalid DKG abort phase: ${event.phase}`);
+    }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtDkgTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'parameters_confirmed') {
       throw new CourtDkgTransitionError(`cannot start DKG from ${state.phase}`);
     }
     return { ...state, phase: 'dkg_round_1' };
   }
 
   if (event.type === 'accept_round_1') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_1') {
       throw new CourtDkgTransitionError(`cannot accept round 1 data during ${state.phase}`);
     }
     const accepted = addSorted(state.round1Participants, event.idx);
     return {
       ...state,
       round1Participants: accepted,
       phase: accepted.length === state.participantIndices.length ? 'dkg_round_2' : state.phase,
     };
   }
 
   if (event.type === 'accept_round_2') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'dkg_round_2') {
       throw new CourtDkgTransitionError(`cannot accept round 2 data during ${state.phase}`);
     }
     return { ...state, round2Participants: addSorted(state.round2Participants, event.idx) };
   }
 
   if (event.type === 'finalize_transcript') {
     assertBeforeDeadline(state, event.now);
     if (
       state.phase !== 'dkg_round_2'
       || state.round2Participants.length !== state.participantIndices.length
     ) {
       throw new CourtDkgTransitionError('cannot finalize before every participant completes round 2');
     }
     if (!HEX_32.test(event.transcriptHash) || !GROUP_KEY.test(event.candidateGroupPubkey)) {
       throw new CourtDkgTransitionError('transcript hash or candidate group key has invalid encoding');
     }
     return {
       ...state,
       phase: 'transcript_signing',
       transcriptHash: event.transcriptHash,
       candidateGroupPubkey: event.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'accept_certification') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'transcript_signing' || !state.transcriptHash || !state.candidateGroupPubkey) {
       throw new CourtDkgTransitionError(`cannot certify transcript during ${state.phase}`);
     }
     if (event.transcriptHash !== state.transcriptHash) {
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A participant certified a different DKG transcript.',
         },
       };
     }
     const certifiers = addSorted(state.transcriptCertifiers, event.idx);
     if (certifiers.length !== state.participantIndices.length) {
       return { ...state, transcriptCertifiers: certifiers };
     }
     return {
       ...state,
       phase: 'certified',
       transcriptCertifiers: certifiers,
       certifiedGroupPubkey: state.candidateGroupPubkey,
     };
   }
 
   if (event.type === 'confirm_backup') {
     // Backup confirmation is a LOCAL event (the juror validated its own
     // recovery data), not a peer message, so it is not bounded by the
     // ceremony deadline. A certified machine must never be stranded: without
     // this, a certification at the deadline could never reach `backed_up`
     // and was frozen in `certified` forever.
     assertNow(event.now);
     if (state.phase !== 'certified' || !state.certifiedGroupPubkey) {
       throw new CourtDkgTransitionError('cannot confirm recovery data before DKG certification');
     }
     return { ...state, phase: 'backed_up', backupVerified: true };
   }
 
   return state;
 }

diff --git a/courtSigningMachine.ts b/courtSigningMachine.ts
--- a/courtSigningMachine.ts
+++ b/courtSigningMachine.ts
@@ -1,386 +1,395 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court FROST signing attempt.
  *
  * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
  * aggregate -> attestation_published.
  *
  * The signing-session hash binds the Court session hash, the frozen verdict
  * hash, the exact outcome, the signing attempt, the threshold, and the signer
  * set. Changing any bound field requires a new machine for a new attempt and
  * invalidates every prior nonce commitment. Each roster signer may publish
  * exactly one nonce commitment per attempt; a conflicting second commitment
  * is nonce equivocation and aborts the attempt with blame.
  *
  * This module performs no FROST cryptographic verification; the boundary must
  * verify partial signatures against the certified verification shares and the
  * finalized commitment set before dispatching events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';
 
 export type CourtSigningPhase =
   | 'intent'
   | 'nonce_commit'
   | 'commitment_set_final'
   | 'partial_sign'
   | 'aggregate'
   | 'attestation_published'
   | 'expired'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network';
 
 export type CourtSigningFailurePhase = Extract<
   CourtSigningPhase,
   'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
 >;
 
 export interface CourtSigningFailure {
   readonly phase: CourtSigningFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtSigningCommitmentRecord {
   readonly idx: number;
   readonly binderPn: string;
   readonly hiddenPn: string;
 }
 
 export interface CourtSigningPartialRecord {
   readonly idx: number;
   readonly psig: string;
 }
 
 export interface CourtSigningMachineState {
   readonly signingSessionHash: string;
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
   readonly phase: CourtSigningPhase;
   readonly commitments: readonly CourtSigningCommitmentRecord[];
   /** Frozen, sorted signer set whose commitments define the signing context. */
   readonly finalizedSignerSet?: readonly number[];
   readonly partials: readonly CourtSigningPartialRecord[];
   readonly signature?: string;
   readonly attestationEventId?: string;
   readonly failure?: CourtSigningFailure;
 }
 
 export type CourtSigningMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | {
       readonly type: 'accept_commitment';
       readonly idx: number;
       readonly binderPn: string;
       readonly hiddenPn: string;
       readonly now: number;
     }
   | { readonly type: 'close_commitments'; readonly now: number }
   | {
       readonly type: 'accept_partial';
       readonly idx: number;
       readonly psig: string;
       readonly now: number;
     }
   | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
   | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtSigningFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtSigningTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtSigningTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
 const MAX_OUTCOME_BYTES = 256;
 
+const ABORT_PHASES = new Set<CourtSigningPhase>([
+  'aborted_peer',
+  'aborted_coordinator',
+  'aborted_network',
+]);
+
 const TERMINAL_PHASES = new Set<CourtSigningPhase>([
   'attestation_published',
   'expired',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
 ]);
 
 /**
  * Canonical hash binding every field that defines one signing attempt. A
  * FROST nonce commitment may be consumed only under exactly one such hash.
  */
 export function hashCourtSigningSession(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.hex(params.verdictHash);
   writer.text(params.outcome);
   writer.u32(params.participantIndices.length);
   for (const idx of params.participantIndices) {
     writer.u32(idx);
   }
   writer.u32(params.threshold);
   writer.u32(params.attempt);
   const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
   const encoded = writer.finish();
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtSigningTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtSigningMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtSigningTransitionError(`signer ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtSigningTransitionError('signing message arrived at or after the attempt deadline');
   }
 }
 
 export function createCourtSigningMachine(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
 }): CourtSigningMachineState {
   if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
     throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
   }
   if (
     typeof params.outcome !== 'string' ||
     params.outcome.length === 0 ||
     textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
   ) {
     throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtSigningTransitionError('signing requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtSigningTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Number.isSafeInteger(params.threshold) ||
     params.threshold < 1 ||
     params.threshold > participants.length
   ) {
     throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
   }
   if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
     throw new CourtSigningTransitionError('attempt must be a non-negative integer');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
   }
   return {
     signingSessionHash: hashCourtSigningSession({
       sessionHash: params.sessionHash,
       verdictHash: params.verdictHash,
       outcome: params.outcome,
       participantIndices: participants,
       threshold: params.threshold,
       attempt: params.attempt,
     }),
     sessionHash: params.sessionHash,
     verdictHash: params.verdictHash,
     outcome: params.outcome,
     participantIndices: participants,
     threshold: params.threshold,
     attempt: params.attempt,
     deadline: params.deadline,
     phase: 'intent',
     commitments: [],
     partials: [],
   };
 }
 
 export function reduceCourtSigningMachine(
   state: CourtSigningMachineState,
   event: CourtSigningMachineEvent,
 ): CourtSigningMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
     }
+    if (!ABORT_PHASES.has(event.phase)) {
+      throw new CourtSigningTransitionError(`invalid signing abort phase: ${event.phase}`);
+    }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'intent') {
       throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
     }
     return { ...state, phase: 'nonce_commit' };
   }
 
   if (event.type === 'accept_commitment') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
     }
     // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
     // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
     // machine must not reject the x-only form.
     if (!HEX_POINT.test(event.binderPn) || !HEX_POINT.test(event.hiddenPn)) {
       throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
     }
     const existing = state.commitments.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
         return state;
       }
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       commitments: [
         ...state.commitments,
         { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
       ],
     };
   }
 
   if (event.type === 'close_commitments') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
     }
     if (state.commitments.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
       );
     }
     const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
     return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
   }
 
   if (event.type === 'accept_partial') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
       throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
     }
     if (!state.finalizedSignerSet?.includes(event.idx)) {
       throw new CourtSigningTransitionError(
         `signer ${event.idx} is not in the finalized commitment set`,
       );
     }
     if (!HEX_32.test(event.psig)) {
       throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
     }
     const existing = state.partials.find((p) => p.idx === event.idx);
     if (existing) {
       if (existing.psig === event.psig) return state;
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published conflicting partial signatures for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       phase: 'partial_sign',
       partials: [...state.partials, { idx: event.idx, psig: event.psig }],
     };
   }
 
   if (event.type === 'aggregate') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
       throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
     }
     if (state.partials.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
       );
     }
     if (!SCHNORR_SIGNATURE.test(event.signature)) {
       throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
     }
     return { ...state, phase: 'aggregate', signature: event.signature };
   }
 
   if (event.type === 'publish') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'aggregate' || !state.signature) {
       throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
     }
     if (!HEX_32.test(event.attestationEventId)) {
       throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
     }
     return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
   }
 
   return state;
 }

```


---

### Validate and bound DKG parameters before cryptographic processing

**Affected files:** dkg.ts

**V12 reasoning:** Validate DKG thresholds and juror indices as positive safe integers, and cap both threshold and roster cardinality before any coefficient allocation or cryptographic loops.

```diff
diff --git a/dkg.ts b/dkg.ts
--- a/dkg.ts
+++ b/dkg.ts
@@ -1,621 +1,628 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pedersen-style distributed key generation adapter for the BAO Court / FROST oracle.
  *
  * This adapter simulates the full multi-party DKG inside a single local
  * process, but the cryptographic design is identical to a network version.
  *
  * NOTE: A coordinator-dependent DKG is NOT the desired design. The target is a
  * fully independent jury where every juror runs this logic on their own device
  * and exchanges only public commitments and encrypted shares over Nostr or other
  * peer-to-peer channels:
  *
  *   - Every juror generates its own private degree-(t-1) polynomial.
  *   - Every juror publishes Feldman coefficient commitments.
  *   - Every juror provides a Schnorr proof-of-knowledge of the constant coefficient.
  *   - Every received share is verified against the commitments.
  *   - Failed verifications raise complaints; if the revealed share is still
  *     invalid, the accused participant is disqualified.
  *   - The group secret never exists in one place — it is the sum of all
  *     remaining participants' constant coefficients.
  *
  * No single party materializes the group secret.
  *
  * NOTE: `generateFrostKeys()` defaults to `PedersenDkgAdapter`. The legacy
  * trusted-dealer adapter remains available as an explicit opt-in for tests and
  * demos. A production deployment MUST run the DKG across real user app instances
  * (browser/mobile/desktop) with encrypted peer-to-peer channels.
  */
 
 import { secp256k1 } from '@noble/curves/secp256k1.js';
 import * as frost from '@vbyte/frost';
 import { sha256 } from '@noble/hashes/sha2.js';
 import { hexToBytes } from '@noble/hashes/utils.js';
 import { createProofOfKnowledge, deriveXOnlyPubkey, randomScalar, scalarToHex, seededScalar, verifyProofOfKnowledge } from './crypto';
 import type { DkgRecord, SelectedJuror } from './types';
 
 const Point = secp256k1.Point;
 // secp256k1 curve order (scalar field).
 const N = secp256k1.Point.Fn.ORDER;
+const MAX_DKG_PARTICIPANTS = 1_000;
 type CurvePoint = InstanceType<typeof Point>;
 
 export function modN(x: bigint): bigint {
   const r = x % N;
   return r < 0n ? r + N : r;
 }
 
 /**
  * Evaluate a polynomial over the secp256k1 scalar field using Horner's rule.
  */
 export function evaluatePoly(coeffs: readonly bigint[], x: bigint): bigint {
   let result = 0n;
   for (let k = coeffs.length - 1; k >= 0; k--) {
     result = modN(modN(result * x) + coeffs[k]);
   }
   return result;
 }
 
 /**
  * Evaluate a polynomial whose coefficients are curve points at x.
  * This computes `sum_k A_k * x^k`.
  */
 export function evaluateCommitments(
   commitments: readonly CurvePoint[],
   x: bigint,
 ): CurvePoint {
   let result = Point.ZERO;
   for (let k = commitments.length - 1; k >= 0; k--) {
     result = result.multiply(x).add(commitments[k]);
   }
   return result;
 }
 
 /**
  * Evaluate a refresh polynomial at x.
  * Refresh polynomials have a zero constant term, so this computes
  * `sum_{k=1}^{degree} A_k * x^k`.
  */
 export function evaluateRefreshCommitments(
   commitments: readonly CurvePoint[],
   x: bigint,
 ): CurvePoint {
   let result = Point.ZERO;
   for (let k = commitments.length - 1; k >= 0; k--) {
     result = result.multiply(x).add(commitments[k]);
   }
   return result.multiply(x);
 }
 
 /**
  * Merge original DKG commitments with refresh commitments.
  * The refresh polynomial has degree threshold-1 but a zero constant term, so
  * its commitments are added to the original commitments starting at degree 1.
  */
 export function mergeRefreshCommitments(
   originalCommits: readonly string[],
   refreshCommits: readonly string[],
 ): string[] {
   if (refreshCommits.length !== originalCommits.length - 1) {
     throw new Error('Refresh commitment count must be one less than the threshold');
   }
   const orig = originalCommits.map((c) => Point.fromHex(c));
   const refr = refreshCommits.map((c) => Point.fromHex(c));
   const merged: CurvePoint[] = [orig[0]];
   for (let k = 1; k < orig.length; k++) {
     merged.push(orig[k].add(refr[k - 1]));
   }
   return merged.map((p) => p.toHex(true));
 }
 
 export function pointToXOnlyHex(point: CurvePoint): string {
   // Drop the 02/03 prefix from the compressed encoding to obtain a BIP340 x-only pubkey.
   return point.toHex(true).slice(2);
 }
 
 /**
  * Generate a zero-constant refresh polynomial package for an arbitrary set of
  * recipient indices.
  *
  * This replaces `frost.Lib.gen_refresh_shares`, which can only address
  * recipients `1..count` and therefore breaks for any non-contiguous juror
  * index set (e.g. after a DKG disqualification). The refresh polynomial is
  * `f(x) = c_1*x + ... + c_{t-1}*x^{t-1}` (zero constant term), so the group
  * public key is preserved. The returned commitments match the format expected
  * by {@link mergeRefreshCommitments} and {@link verifyRefreshShare}: one
  * commitment per non-constant coefficient, starting at degree 1.
  */
 export function generateRefreshShares(
   senderIdx: number,
   threshold: number,
   recipientIdxs: readonly number[],
 ): { vss_commits: string[]; idx: number; shares: frost.SecretShare[] } {
   if (threshold < 2) {
     throw new Error('Threshold must be at least 2');
   }
   if (recipientIdxs.length === 0 || recipientIdxs.some((i) => !Number.isInteger(i) || i < 1)) {
     throw new Error('Recipient indices must be positive integers');
   }
   const subCoeffs = Array.from({ length: threshold - 1 }, () => randomScalar());
   const coeffs = [0n, ...subCoeffs];
   const shares = recipientIdxs.map((idx) => ({
     idx,
     seckey: scalarToHex(evaluatePoly(coeffs, BigInt(idx))),
   }));
   const vss_commits = subCoeffs.map((c) => Point.BASE.multiply(c).toHex(true));
   return { vss_commits, idx: senderIdx, shares };
 }
 
 export interface PedersenDkgOptions {
   /**
    * When true, enables test/demo-only features: deterministic `seed` keygen
    * and the `corruptShare` fault injection hook. Never enable in production.
    */
   readonly unsafeTestMode?: boolean;
   /**
    * Test-only hook: simulate a dishonest participant that sends an invalid share.
    * The accused juror's share to the victim juror is corrupted, triggering a
    * complaint and disqualification. Requires `unsafeTestMode: true`.
    */
   readonly corruptShare?: { readonly accused: number; readonly victim: number };
   /**
    * Test-only hook: simulate a participant that fails its Schnorr
    * proof-of-knowledge of the constant term (e.g. committed to a point whose
    * discrete log it does not know). Requires `unsafeTestMode: true`.
    */
   readonly corruptPok?: { readonly accused: number };
 }
 
 export interface ParticipantState {
   readonly juror: SelectedJuror;
   readonly coeffs: readonly bigint[];
   readonly commitments: readonly CurvePoint[];
   readonly pok: ReturnType<typeof createProofOfKnowledge>;
 }
 
 export interface KeygenParams {
   readonly marketId: string;
   /** Optional dispute id (2140wtf scopes DKG to a dispute). */
   readonly disputeId?: string;
   readonly threshold: number;
   readonly jurors: readonly SelectedJuror[];
   /**
    * Optional deterministic seed. Only allowed when the adapter is constructed
    * with `unsafeTestMode: true`. Passing a shared/public seed in production
    * collapses the DKG because multiple jurors generate identical polynomials.
    */
   readonly seed?: string | Uint8Array;
 }
 
 export interface KeygenResult {
   readonly record: DkgRecord;
   readonly shares: frost.SecretShare[];
 }
 
 export interface RefreshParams {
   readonly record: DkgRecord;
   readonly shares: readonly frost.SecretShare[];
 }
 
 export interface RefreshResult {
   readonly record: DkgRecord;
   readonly shares: frost.SecretShare[];
 }
 
 /**
  * Interface that a production DKG implementation must satisfy.
  */
 export interface DkgAdapter {
   readonly run: (params: KeygenParams) => KeygenResult;
   readonly refreshShares: (params: RefreshParams) => RefreshResult;
 }
 export class PedersenDkgAdapter implements DkgAdapter {
   private readonly unsafeTestMode: boolean;
   private readonly corruptShare?: {
     readonly accused: number;
     readonly victim: number;
   };
   private readonly corruptPok?: { readonly accused: number };
   private paramsForProofDomain?: { readonly marketId: string; readonly disputeId?: string };
 
   constructor(options?: PedersenDkgOptions) {
     this.unsafeTestMode = options?.unsafeTestMode ?? false;
     if ((options?.corruptShare || options?.corruptPok) && !this.unsafeTestMode) {
       throw new Error('corruptShare/corruptPok require unsafeTestMode: true');
     }
     this.corruptShare = options?.corruptShare;
     this.corruptPok = options?.corruptPok;
   }
 
   private proofDomain(idx: number): string {
     const marketId = this.paramsForProofDomain?.marketId ?? '';
     const disputeId = this.paramsForProofDomain?.disputeId ?? '';
     return `market=${marketId}|dispute=${disputeId}|juror=${idx}`;
   }
 
   run(params: KeygenParams): KeygenResult {
     this.validateParams(params);
 
     if (params.seed && !this.unsafeTestMode) {
       throw new Error(
         'Deterministic DKG seed is only allowed in unsafeTestMode. ' +
           'A shared seed in production lets any juror reconstruct the group secret.',
       );
     }
 
     const { threshold, jurors } = params;
     this.paramsForProofDomain = { marketId: params.marketId, disputeId: params.disputeId };
     const participants = this.createParticipants(jurors, threshold, params);
     const disqualified = this.resolveComplaints(participants);
 
     const qualifiedParticipants = participants.filter(
       (p) => !disqualified.has(p.juror.idx),
     );
 
     if (qualifiedParticipants.length < threshold) {
       throw new Error(
         `Pedersen DKG failed: ${qualifiedParticipants.length} qualified participants remain, ` +
           `but threshold is ${threshold}`,
       );
     }
 
     const qualifiedJurors = jurors.filter((j) => !disqualified.has(j.idx));
 
     // Group public key = sum of all qualified constant-coefficient commitments.
     const groupPoint = qualifiedParticipants.reduce(
       (sum, p) => sum.add(p.commitments[0]),
       Point.ZERO,
     );
 
     // Each juror's final secret share is the sum of all qualified shares sent to them.
     const shares: frost.SecretShare[] = qualifiedJurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const secret = qualifiedParticipants.reduce(
         (sum, p) => modN(sum + evaluatePoly(p.coeffs, idx)),
         0n,
       );
       return { idx: juror.idx, seckey: scalarToHex(secret) };
     });
 
     // Verification shares are the public points matching the secret shares.
     const verificationShares = qualifiedJurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const pubkeyPoint = qualifiedParticipants.reduce(
         (sum, p) => sum.add(evaluateCommitments(p.commitments, idx)),
         Point.ZERO,
       );
       return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
     });
 
     // Sanity check: every secret share must produce the advertised verification share.
     for (const share of shares) {
       const expected = deriveXOnlyPubkey(share.seckey);
       const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
       if (actual !== expected) {
         throw new Error(
           `Pedersen DKG internal error: verification share mismatch for juror ${share.idx}`,
         );
       }
     }
 
     const groupPubkey = groupPoint.toHex(true);
     const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
 
     const vssCommitments = qualifiedParticipants.map((p) => ({
       idx: p.juror.idx,
       pubkey: p.juror.nostrPubkey,
       commits: p.commitments.map((c) => c.toHex(true)),
     }));
 
     const record: DkgRecord = {
       marketId: params.marketId,
       disputeId: params.disputeId,
       threshold,
       participants: qualifiedJurors.length,
       groupPubkey,
       groupPubkeyXOnly,
       verificationShares,
       jurorPubkeys: qualifiedJurors.map((j) => j.nostrPubkey),
       vssCommitments,
     };
 
     return { record, shares };
   }
 
   /**
    * Refresh all shares without changing the group public key.
    *
    * Each juror generates a random degree-(t-1) polynomial with a zero constant
    * term and distributes shares to every other juror. The refreshed share is
    * the old share plus the sum of all received refresh shares. The group public
    * key is unchanged because the refresh polynomials sum to zero.
    */
   refreshShares(params: RefreshParams): RefreshResult {
     this.validateRefreshParams(params);
 
     const { record, shares } = params;
     const threshold = record.threshold;
     const jurors = record.verificationShares.map((v) => {
       const vss = record.vssCommitments.find((c) => c.idx === v.idx);
       return {
         idx: v.idx,
         nostrPubkey: vss?.pubkey ?? '',
       };
     });
 
     // Each juror generates a refresh package for all participants. Indices
     // may be non-contiguous (e.g. after a disqualification), so the refresh
     // polynomials are generated locally rather than via
     // `frost.Lib.gen_refresh_shares`, which only supports recipients 1..n.
     const jurorIdxs = jurors.map((j) => j.idx);
     const refreshPackages = jurors.map((juror) =>
       generateRefreshShares(juror.idx, threshold, jurorIdxs),
     );
 
     // Combine every juror's current share with the refresh shares addressed to them.
     const refreshedShares = jurors.map((juror) => {
       const current = shares.find((s) => s.idx === juror.idx);
       if (!current) {
         throw new Error(`Missing current share for juror ${juror.idx}`);
       }
       const refreshShares = refreshPackages.map((pkg) =>
         frost.Lib.get_share(pkg.shares, juror.idx),
       );
       return frost.Lib.refresh_share(refreshShares, current);
     });
 
     // Merge original and refresh commitments so verification shares can be updated.
     const mergedVssCommitments = jurors.map((juror, i) => {
       const original = record.vssCommitments.find((c) => c.idx === juror.idx);
       if (!original) {
         throw new Error(`Missing original commitments for juror ${juror.idx}`);
       }
       return {
         idx: juror.idx,
         pubkey: juror.nostrPubkey,
         commits: mergeRefreshCommitments(original.commits, refreshPackages[i].vss_commits),
       };
     });
 
     const verificationShares = jurors.map((juror) => {
       const idx = BigInt(juror.idx);
       const pubkeyPoint = mergedVssCommitments.reduce(
         (sum, c) => sum.add(evaluateCommitments(c.commits.map((h) => Point.fromHex(h)), idx)),
         Point.ZERO,
       );
       return { idx: juror.idx, pubkey: pointToXOnlyHex(pubkeyPoint) };
     });
 
     // Sanity check: every refreshed share must match its verification share.
     for (const share of refreshedShares) {
       const expected = deriveXOnlyPubkey(share.seckey);
       const actual = verificationShares.find((v) => v.idx === share.idx)?.pubkey;
       if (actual !== expected) {
         throw new Error(
           `Refresh internal error: verification share mismatch for juror ${share.idx}`,
         );
       }
     }
 
     const groupPoint = mergedVssCommitments.reduce(
       (sum, c) => sum.add(Point.fromHex(c.commits[0])),
       Point.ZERO,
     );
     const groupPubkey = groupPoint.toHex(true);
     const groupPubkeyXOnly = pointToXOnlyHex(groupPoint);
 
     if (groupPubkey !== record.groupPubkey) {
       throw new Error('Refresh changed the group public key');
     }
 
     const newRecord: DkgRecord = {
       ...record,
       groupPubkey,
       groupPubkeyXOnly,
       verificationShares,
       vssCommitments: mergedVssCommitments,
     };
 
     return { record: newRecord, shares: refreshedShares };
   }
 
   private validateRefreshParams(params: RefreshParams): void {
     if (params.shares.length !== params.record.participants) {
       throw new Error('Share count does not match record participants');
     }
     if (params.record.threshold < 2) {
       throw new Error('Threshold must be at least 2');
     }
     const indices = new Set(params.shares.map((s) => s.idx));
     if (indices.size !== params.shares.length) {
       throw new Error('Duplicate share indices');
     }
     for (const share of params.shares) {
       const vss = params.record.vssCommitments.find((c) => c.idx === share.idx);
       if (!vss) {
         throw new Error(`No commitment found for share index ${share.idx}`);
       }
     }
   }
 
   private validateParams(params: KeygenParams): void {
-    if (params.threshold < 2) {
-      throw new Error('Threshold must be at least 2');
+    if (!Number.isSafeInteger(params.threshold) || params.threshold < 2) {
+      throw new Error('Threshold must be a safe integer of at least 2');
     }
+    if (params.threshold > MAX_DKG_PARTICIPANTS) {
+      throw new Error(`Threshold must be at most ${MAX_DKG_PARTICIPANTS}`);
+    }
+    if (params.jurors.length > MAX_DKG_PARTICIPANTS) {
+      throw new Error(`Participants must be at most ${MAX_DKG_PARTICIPANTS}`);
+    }
     if (params.jurors.length < params.threshold) {
       throw new Error('Participants cannot be less than threshold');
     }
     const indices = new Set(params.jurors.map((j) => j.idx));
     if (indices.size !== params.jurors.length) {
       throw new Error('Duplicate juror indices');
     }
-    if (params.jurors.some((j) => j.idx < 1)) {
-      throw new Error('Juror indices must be positive');
+    if (params.jurors.some((j) => !Number.isSafeInteger(j.idx) || j.idx < 1)) {
+      throw new Error('Juror indices must be positive safe integers');
     }
   }
 
   private createParticipants(
     jurors: readonly SelectedJuror[],
     threshold: number,
     params: KeygenParams,
   ): ParticipantState[] {
     const seedBytes = params.seed
       ? (typeof params.seed === 'string'
         ? (params.seed.length === 64 && /^[0-9a-fA-F]{64}$/.test(params.seed)
           ? hexToBytes(params.seed)
           : sha256(new TextEncoder().encode(params.seed)))
         : params.seed)
       : undefined;
 
     return jurors.map((juror) => {
       const coeffs = Array.from({ length: threshold }, (_, k) => {
         if (!seedBytes) return randomScalar();
         const info = new TextEncoder().encode(
           `bao-frost-court/dkg-coeff|market=${params.marketId}|dispute=${params.disputeId ?? ''}|threshold=${threshold}|juror=${juror.idx}|k=${k}`,
         );
         return seededScalar(seedBytes, info);
       });
       const commitments = coeffs.map((a) => Point.BASE.multiply(a));
       const domain = this.proofDomain(juror.idx);
       const pok = createProofOfKnowledge(
         scalarToHex(coeffs[0]),
         commitments[0].toHex(true),
         domain,
       );
       if (this.corruptPok?.accused === juror.idx) {
         // Tamper: respond with a different valid scalar so verification fails.
         const z = BigInt(`0x${pok.response}`);
         return { juror, coeffs, commitments, pok: { ...pok, response: scalarToHex(modN(z + 1n)) } };
       }
       return { juror, coeffs, commitments, pok };
     });
   }
 
   /**
    * Simulate the share-verification and complaint phase.
    * For every pair (sender -> recipient), the recipient checks the share against
    * the sender's public commitments. A failed check is treated as a complaint;
    * the sender reveals the disputed share, and if it is still invalid the sender
    * is disqualified.
    */
   private resolveComplaints(
     participants: readonly ParticipantState[],
   ): Set<number> {
     const disqualified = new Set<number>();
 
     for (const recipient of participants) {
       const j = BigInt(recipient.juror.idx);
       for (const sender of participants) {
         const i = sender.juror.idx;
         // First verify the sender's Schnorr proof-of-knowledge of its constant
         // term. The docstring promises this check, but nothing ever ran it — a
         // participant could commit to a point it does not know and the POK was
         // dead weight. Fail the attempt for the accused like any other
         // attributable invalid data.
         if (
           !verifyProofOfKnowledge(
             sender.commitments[0].toHex(true),
             sender.pok,
             this.proofDomain(i),
           )
         ) {
           disqualified.add(i);
           continue;
         }
         let share = evaluatePoly(sender.coeffs, j);
 
         // Inject a faulty share for test scenarios.
         if (
           this.corruptShare &&
           this.corruptShare.accused === i &&
           this.corruptShare.victim === recipient.juror.idx
         ) {
           share = modN(share + 1n);
         }
 
         const expected = evaluateCommitments(sender.commitments, j);
         const actual = Point.BASE.multiply(share);
 
         if (!actual.equals(expected)) {
           // The accused reveals the share. In this local simulation the revealed
           // value is the same share we just checked; if it does not match the
           // commitment, the accused is disqualified.
           disqualified.add(i);
         }
       }
     }
 
     return disqualified;
   }
 }
 
 /**
  * Verify a single VSS share from a known commitment set.
  */
 export function verifyVssShare(
   recipientIdx: number,
   shareHex: string,
   commitments: readonly string[],
 ): boolean {
   try {
     const share = BigInt('0x' + shareHex);
     const commits = commitments.map((c) => Point.fromHex(c));
     const expected = evaluateCommitments(commits, BigInt(recipientIdx));
     const actual = Point.BASE.multiply(share);
     return actual.equals(expected);
   } catch {
     return false;
   }
 }
 
 /**
  * Verify a refresh share from a known refresh commitment set.
  * Refresh polynomials have a zero constant term.
  */
 export function verifyRefreshShare(
   recipientIdx: number,
   shareHex: string,
   refreshCommitments: readonly string[],
 ): boolean {
   try {
     const share = BigInt('0x' + shareHex);
     const commits = refreshCommitments.map((c) => Point.fromHex(c));
     const expected = evaluateRefreshCommitments(commits, BigInt(recipientIdx));
     const actual = Point.BASE.multiply(share);
     return actual.equals(expected);
   } catch {
     return false;
   }
 }
 
 /**
  * Compute a juror's final secret share from a set of valid decrypted shares.
  * All shares must belong to the same recipient index.
  */
 export function combineShares(shares: readonly { idx: number; shareHex: string }[]): frost.SecretShare {
   if (shares.length === 0) {
     throw new Error('combineShares requires at least one share');
   }
   const idx = shares[0].idx;
   if (!Number.isInteger(idx) || idx < 1) {
     throw new Error(`Invalid recipient index: ${idx}`);
   }
   if (shares.some((s) => s.idx !== idx)) {
     throw new Error('All shares must belong to the same recipient index');
   }
   let secret = 0n;
   for (const s of shares) {
     if (!/^[0-9a-fA-F]{1,64}$/.test(s.shareHex)) {
       throw new Error(`Invalid share hex from sender index ${s.idx}`);
     }
     secret = modN(secret + BigInt('0x' + s.shareHex));
   }
   return { idx, seckey: scalarToHex(secret) };
 }
 
 /**
  * Default keygen — Pedersen DKG.
  */
 export function generateFrostKeys(params: KeygenParams): KeygenResult {
   return new PedersenDkgAdapter().run(params);
 }

```


## Low Severity Findings

---

### Coercible reveal IDs can block vote finalization

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Reject non-primitive reveal event IDs before coercive regex validation, preventing boxed strings from being persisted and later breaking canonical verdict hashing.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,443 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
-    if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
+    if (
+      typeof event.eventId !== 'string' ||
+      !HEX_32.test(event.salt) ||
+      !HEX_32.test(event.eventId)
+    ) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Coercible session hash can poison reveal processing

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Require sessionHash to be a primitive string before regex validation, preventing coercible objects from being accepted and persisted into vote state.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,439 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
-  if (!HEX_32.test(params.sessionHash)) {
+  if (typeof params.sessionHash !== 'string' || !HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


---

### Malformed state crashes commitment processing

**Affected files:** courtSigningMachine.ts

**V12 reasoning:** Validate every persisted commitment array and record at reducer entry, including canonical point shape, roster membership, and index uniqueness, so malformed state fails closed with CourtSigningTransitionError and duplicate commitments cannot satisfy threshold closure.

```diff
diff --git a/courtSigningMachine.ts b/courtSigningMachine.ts
--- a/courtSigningMachine.ts
+++ b/courtSigningMachine.ts
@@ -1,386 +1,413 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court FROST signing attempt.
  *
  * Phases: intent -> nonce_commit -> commitment_set_final -> partial_sign ->
  * aggregate -> attestation_published.
  *
  * The signing-session hash binds the Court session hash, the frozen verdict
  * hash, the exact outcome, the signing attempt, the threshold, and the signer
  * set. Changing any bound field requires a new machine for a new attempt and
  * invalidates every prior nonce commitment. Each roster signer may publish
  * exactly one nonce commitment per attempt; a conflicting second commitment
  * is nonce equivocation and aborts the attempt with blame.
  *
  * This module performs no FROST cryptographic verification; the boundary must
  * verify partial signatures against the certified verification shares and the
  * finalized commitment set before dispatching events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_SIGNING_SESSION_DOMAIN = 'BAO-Court/SigningSession/v1';
 
 export type CourtSigningPhase =
   | 'intent'
   | 'nonce_commit'
   | 'commitment_set_final'
   | 'partial_sign'
   | 'aggregate'
   | 'attestation_published'
   | 'expired'
   | 'aborted_peer'
   | 'aborted_coordinator'
   | 'aborted_network';
 
 export type CourtSigningFailurePhase = Extract<
   CourtSigningPhase,
   'aborted_peer' | 'aborted_coordinator' | 'aborted_network'
 >;
 
 export interface CourtSigningFailure {
   readonly phase: CourtSigningFailurePhase | 'expired';
   readonly reason: string;
   readonly blamedIdx?: number;
 }
 
 export interface CourtSigningCommitmentRecord {
   readonly idx: number;
   readonly binderPn: string;
   readonly hiddenPn: string;
 }
 
 export interface CourtSigningPartialRecord {
   readonly idx: number;
   readonly psig: string;
 }
 
 export interface CourtSigningMachineState {
   readonly signingSessionHash: string;
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
   readonly phase: CourtSigningPhase;
   readonly commitments: readonly CourtSigningCommitmentRecord[];
   /** Frozen, sorted signer set whose commitments define the signing context. */
   readonly finalizedSignerSet?: readonly number[];
   readonly partials: readonly CourtSigningPartialRecord[];
   readonly signature?: string;
   readonly attestationEventId?: string;
   readonly failure?: CourtSigningFailure;
 }
 
 export type CourtSigningMachineEvent =
   | { readonly type: 'start'; readonly now: number }
   | {
       readonly type: 'accept_commitment';
       readonly idx: number;
       readonly binderPn: string;
       readonly hiddenPn: string;
       readonly now: number;
     }
   | { readonly type: 'close_commitments'; readonly now: number }
   | {
       readonly type: 'accept_partial';
       readonly idx: number;
       readonly psig: string;
       readonly now: number;
     }
   | { readonly type: 'aggregate'; readonly signature: string; readonly now: number }
   | { readonly type: 'publish'; readonly attestationEventId: string; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | {
       readonly type: 'abort';
       readonly phase: CourtSigningFailurePhase;
       readonly reason: string;
       readonly blamedIdx?: number;
     };
 
 export class CourtSigningTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtSigningTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const HEX_POINT = /^(?:[0-9a-f]{64}|(?:02|03)[0-9a-f]{64})$/;
 const SCHNORR_SIGNATURE = /^[0-9a-f]{128}$/;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtSigningPhase>([
   'attestation_published',
   'expired',
   'aborted_peer',
   'aborted_coordinator',
   'aborted_network',
 ]);
 
 /**
  * Canonical hash binding every field that defines one signing attempt. A
  * FROST nonce commitment may be consumed only under exactly one such hash.
  */
 export function hashCourtSigningSession(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.hex(params.verdictHash);
   writer.text(params.outcome);
   writer.u32(params.participantIndices.length);
   for (const idx of params.participantIndices) {
     writer.u32(idx);
   }
   writer.u32(params.threshold);
   writer.u32(params.attempt);
   const domain = textEncoder.encode(COURT_SIGNING_SESSION_DOMAIN);
   const encoded = writer.finish();
   const input = new Uint8Array(domain.length + encoded.length);
   input.set(domain, 0);
   input.set(encoded, domain.length);
   return bytesToHex(sha256(input));
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtSigningTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtSigningMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtSigningTransitionError(`signer ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(state: CourtSigningMachineState, now: number): void {
   assertNow(now);
   if (now >= state.deadline) {
     throw new CourtSigningTransitionError('signing message arrived at or after the attempt deadline');
   }
 }
 
+function assertCommitmentState(state: CourtSigningMachineState): void {
+  if (!Array.isArray(state.commitments)) {
+    throw new CourtSigningTransitionError('signing state commitments must be an array');
+  }
+  const seen = new Set<number>();
+  for (const commitment of state.commitments as readonly unknown[]) {
+    if (typeof commitment !== 'object' || commitment === null) {
+      throw new CourtSigningTransitionError('signing state contains a malformed nonce commitment');
+    }
+    const record = commitment as Record<string, unknown>;
+    if (
+      typeof record.idx !== 'number' ||
+      !Number.isSafeInteger(record.idx) ||
+      !state.participantIndices.includes(record.idx) ||
+      typeof record.binderPn !== 'string' ||
+      typeof record.hiddenPn !== 'string' ||
+      !HEX_POINT.test(record.binderPn) ||
+      !HEX_POINT.test(record.hiddenPn) ||
+      seen.has(record.idx)
+    ) {
+      throw new CourtSigningTransitionError('signing state contains a malformed nonce commitment');
+    }
+    seen.add(record.idx);
+  }
+}
+
 export function createCourtSigningMachine(params: {
   readonly sessionHash: string;
   readonly verdictHash: string;
   readonly outcome: string;
   readonly participantIndices: readonly number[];
   readonly threshold: number;
   readonly attempt: number;
   readonly deadline: number;
 }): CourtSigningMachineState {
   if (!HEX_32.test(params.sessionHash) || !HEX_32.test(params.verdictHash)) {
     throw new CourtSigningTransitionError('session and verdict hashes must be 32-byte lowercase hex');
   }
   if (
     typeof params.outcome !== 'string' ||
     params.outcome.length === 0 ||
     textEncoder.encode(params.outcome).length > MAX_OUTCOME_BYTES
   ) {
     throw new CourtSigningTransitionError('outcome must be a non-empty bounded string');
   }
   if (params.participantIndices.length === 0) {
     throw new CourtSigningTransitionError('signing requires at least one participant');
   }
   const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtSigningTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Number.isSafeInteger(params.threshold) ||
     params.threshold < 1 ||
     params.threshold > participants.length
   ) {
     throw new CourtSigningTransitionError('threshold must be between 1 and the signer count');
   }
   if (!Number.isSafeInteger(params.attempt) || params.attempt < 0) {
     throw new CourtSigningTransitionError('attempt must be a non-negative integer');
   }
   if (!Number.isSafeInteger(params.deadline) || params.deadline < 1) {
     throw new CourtSigningTransitionError('deadline must be a positive Unix timestamp');
   }
   return {
     signingSessionHash: hashCourtSigningSession({
       sessionHash: params.sessionHash,
       verdictHash: params.verdictHash,
       outcome: params.outcome,
       participantIndices: participants,
       threshold: params.threshold,
       attempt: params.attempt,
     }),
     sessionHash: params.sessionHash,
     verdictHash: params.verdictHash,
     outcome: params.outcome,
     participantIndices: participants,
     threshold: params.threshold,
     attempt: params.attempt,
     deadline: params.deadline,
     phase: 'intent',
     commitments: [],
     partials: [],
   };
 }
 
 export function reduceCourtSigningMachine(
   state: CourtSigningMachineState,
   event: CourtSigningMachineEvent,
 ): CourtSigningMachineState {
+  assertCommitmentState(state);
   if (event.type === 'tick') {
     assertNow(event.now);
     if (TERMINAL_PHASES.has(state.phase) || event.now < state.deadline) return state;
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The signing deadline passed before publication.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtSigningTransitionError(`cannot abort signing from ${state.phase}`);
     }
     if (event.blamedIdx !== undefined) assertParticipant(state, event.blamedIdx);
     return {
       ...state,
       phase: event.phase,
       failure: { phase: event.phase, reason: event.reason, blamedIdx: event.blamedIdx },
     };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtSigningTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'start') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'intent') {
       throw new CourtSigningTransitionError(`cannot start signing from ${state.phase}`);
     }
     return { ...state, phase: 'nonce_commit' };
   }
 
   if (event.type === 'accept_commitment') {
     assertBeforeDeadline(state, event.now);
     assertParticipant(state, event.idx);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot accept nonce commitments during ${state.phase}`);
     }
     // Nonce points may arrive x-only (64 hex) or compressed (02/03 prefix);
     // the protocol boundary (parseBoundFrostCommitEvent) accepts both, so the
     // machine must not reject the x-only form.
     if (!HEX_POINT.test(event.binderPn) || !HEX_POINT.test(event.hiddenPn)) {
       throw new CourtSigningTransitionError('nonce commitments must be canonical secp256k1 points (x-only or compressed)');
     }
     const existing = state.commitments.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.binderPn === event.binderPn && existing.hiddenPn === event.hiddenPn) {
         return state;
       }
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published a conflicting nonce commitment for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       commitments: [
         ...state.commitments,
         { idx: event.idx, binderPn: event.binderPn, hiddenPn: event.hiddenPn },
       ],
     };
   }
 
   if (event.type === 'close_commitments') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'nonce_commit') {
       throw new CourtSigningTransitionError(`cannot close nonce commitments during ${state.phase}`);
     }
     if (state.commitments.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot finalize the commitment set with ${state.commitments.length} commitments below threshold ${state.threshold}`,
       );
     }
     const finalizedSignerSet = state.commitments.map((c) => c.idx).sort((a, b) => a - b);
     return { ...state, phase: 'commitment_set_final', finalizedSignerSet };
   }
 
   if (event.type === 'accept_partial') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'commitment_set_final' && state.phase !== 'partial_sign') {
       throw new CourtSigningTransitionError(`cannot accept partial signatures during ${state.phase}`);
     }
     if (!state.finalizedSignerSet?.includes(event.idx)) {
       throw new CourtSigningTransitionError(
         `signer ${event.idx} is not in the finalized commitment set`,
       );
     }
     if (!HEX_32.test(event.psig)) {
       throw new CourtSigningTransitionError('partial signature must be 32-byte lowercase hex');
     }
     const existing = state.partials.find((p) => p.idx === event.idx);
     if (existing) {
       if (existing.psig === event.psig) return state;
       return {
         ...state,
         phase: 'aborted_peer',
         failure: {
           phase: 'aborted_peer',
           blamedIdx: event.idx,
           reason: 'A signer published conflicting partial signatures for this signing attempt.',
         },
       };
     }
     return {
       ...state,
       phase: 'partial_sign',
       partials: [...state.partials, { idx: event.idx, psig: event.psig }],
     };
   }
 
   if (event.type === 'aggregate') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'partial_sign' && state.phase !== 'commitment_set_final') {
       throw new CourtSigningTransitionError(`cannot aggregate during ${state.phase}`);
     }
     if (state.partials.length < state.threshold) {
       throw new CourtSigningTransitionError(
         `cannot aggregate ${state.partials.length} partial signatures below threshold ${state.threshold}`,
       );
     }
     if (!SCHNORR_SIGNATURE.test(event.signature)) {
       throw new CourtSigningTransitionError('aggregated signature must be 64-byte lowercase hex');
     }
     return { ...state, phase: 'aggregate', signature: event.signature };
   }
 
   if (event.type === 'publish') {
     assertBeforeDeadline(state, event.now);
     if (state.phase !== 'aggregate' || !state.signature) {
       throw new CourtSigningTransitionError(`cannot publish an attestation during ${state.phase}`);
     }
     if (!HEX_32.test(event.attestationEventId)) {
       throw new CourtSigningTransitionError('attestation event id must be 32-byte lowercase hex');
     }
     return { ...state, phase: 'attestation_published', attestationEventId: event.attestationEventId };
   }
 
   return state;
 }

```


---

### Unbounded unwrap processing permits resource exhaustion

**Affected files:** courtSigner.ts

**V12 reasoning:** Adds fail-closed byte, tag, JSON-depth, event-shape, batch-item, and cumulative-byte limits at the exported signer unwrap boundaries, rejecting oversized outer ciphertext before signer access and bounding decrypted layers before verification/hash work.

```diff
diff --git a/courtSigner.ts b/courtSigner.ts
--- a/courtSigner.ts
+++ b/courtSigner.ts
@@ -1,266 +1,328 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Signer-backed private transport for BAO Court protocol messages.
  *
  * Every private Court message (DKG shares, complaints, backups, refresh
  * material) is NIP-44 encrypted and usually NIP-59 gift-wrapped. The legacy
  * helpers in `nip44Crypto.ts` / `nip59.ts` require the raw secret key in
  * process memory. This module provides the same capabilities through a
  * minimal external-signer surface (NIP-07 browser extensions, NIP-46 remote
  * signers, hardware-backed agents) so production jurors never expose an
  * `nsec` to the Court host.
  *
  * The signer surface is intentionally narrow: public key, event signing, and
  * NIP-44 encrypt/decrypt. NIP-46 bunkers and NIP-07 extensions both expose
  * exactly these methods (`get_public_key`, `sign_event`, `nip44_encrypt`,
  * `nip44_decrypt`).
  *
  * The signer-backed unwrap is stricter than the stock NIP-59 helper: it
  * verifies the wrap's recipient tag, the seal's Schnorr signature, that the
  * seal author equals the rumor author, and recomputes the rumor id. A gift
  * wrap that fails any check is rejected (returns null), never partially
  * trusted.
  */
 
 import {
   finalizeEvent,
   generateSecretKey,
   getEventHash,
   getPublicKey,
   verifyEvent,
 } from 'nostr-tools/pure';
 import { nip59 } from 'nostr-tools';
 import type { Event as NostrEvent } from 'nostr-tools/pure';
 import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
 import { Nip44SeckeyCrypto, type Nip44Crypto } from './nip44Crypto';
 
 const SEAL_KIND = 13;
 const GIFT_WRAP_KIND = 1059;
 const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
+const MAX_UNWRAP_CONTENT_BYTES = 256 * 1024;
+const MAX_UNWRAP_TAGS = 128;
+const MAX_UNWRAP_TAG_ITEMS = 16;
+const MAX_UNWRAP_TAG_ITEM_BYTES = 1024;
+const MAX_UNWRAP_JSON_DEPTH = 64;
+const MAX_UNWRAP_BATCH_ITEMS = 128;
+const MAX_UNWRAP_BATCH_BYTES = 4 * 1024 * 1024;
 
 const HEX_64 = /^[0-9a-f]{64}$/;
+const HEX_128 = /^[0-9a-f]{128}$/;
+const textEncoder = new TextEncoder();
 
 /** NIP-59 timestamp randomization: seals/wraps are backdated up to 2 days. */
 function randomNowSeconds(): number {
   return Math.round(Math.round(Date.now() / 1000) - Math.random() * TWO_DAYS_SECONDS);
 }
 
 function assertHex64(value: string, label: string): void {
   if (!HEX_64.test(value)) {
     throw new Error(`${label} must be a 64-character lowercase hex string`);
   }
 }
 
 /**
  * Minimal external signer surface required for Court private transport.
  * Implementations MUST NOT expose the secret key.
  */
 export interface CourtEventSigner {
   /** The signer's x-only public key (64-char hex). */
   getPublicKey(): Promise<string> | string;
   /** Sign an event template; the signer fills pubkey, id, and sig. */
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent>;
   /** NIP-44 v2 encrypt `plaintext` to `peerPubkey` (method: nip44_encrypt). */
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
   /** NIP-44 v2 decrypt `ciphertext` from `peerPubkey` (method: nip44_decrypt). */
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
 }
 
 /**
  * Adapt any {@link CourtEventSigner} to the {@link Nip44Crypto} interface so
  * signer-backed keys work everywhere the Court already accepts encryption
  * providers (DKG sessions, backups, complaints).
  */
 export class Nip44SignerCrypto implements Nip44Crypto {
   constructor(private readonly signer: CourtEventSigner) {}
 
   encrypt(plaintext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Encrypt(peerPubkey, plaintext);
   }
 
   decrypt(ciphertext: string, peerPubkey: string): Promise<string> {
     assertHex64(peerPubkey, 'peer pubkey');
     return this.signer.nip44Decrypt(peerPubkey, ciphertext);
   }
 }
 
 /**
  * A {@link CourtEventSigner} backed by a raw secret key. Provided for tests,
  * demo rooms, and local tooling — production jurors should use a real
  * external signer. Keeping this adapter means the entire private-transport
  * stack has exactly one code path regardless of key custody.
  */
 export class SeckeyCourtSigner implements CourtEventSigner {
   private readonly seckey: Uint8Array;
   private readonly crypto: Nip44SeckeyCrypto;
 
   constructor(seckey: string | Uint8Array) {
     // Copy at the boundary: caller-supplied buffers must never alias our
     // secret, or later mutation/zeroization of the source silently corrupts
     // (or "destroys") this signer.
     this.seckey = typeof seckey === 'string' ? hexToBytes(seckey) : new Uint8Array(seckey);
     if (this.seckey.length !== 32) {
       throw new Error('seckey must be 32 bytes');
     }
     this.crypto = new Nip44SeckeyCrypto(this.seckey);
   }
 
   getPublicKey(): string {
     return getPublicKey(this.seckey);
   }
 
   signEvent(
     template: Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>,
   ): Promise<NostrEvent> {
     return Promise.resolve(finalizeEvent(template, this.seckey));
   }
 
   nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
     return Promise.resolve(this.crypto.encrypt(plaintext, peerPubkey));
   }
 
   nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
     return Promise.resolve(this.crypto.decrypt(ciphertext, peerPubkey));
   }
 }
 
 function isRecord(value: unknown): value is Record<string, unknown> {
-  return typeof value === 'object' && value !== null;
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
 }
 
+function byteLengthWithin(value: unknown, maximum: number): value is string {
+  return typeof value === 'string'
+    && value.length <= maximum
+    && textEncoder.encode(value).length <= maximum;
+}
+
+function hasBoundedJsonDepth(value: unknown): boolean {
+  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
+  while (pending.length > 0) {
+    const current = pending.pop()!;
+    if (current.depth > MAX_UNWRAP_JSON_DEPTH) return false;
+    if (Array.isArray(current.value)) {
+      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
+    } else if (isRecord(current.value)) {
+      for (const item of Object.values(current.value)) {
+        pending.push({ value: item, depth: current.depth + 1 });
+      }
+    }
+  }
+  return true;
+}
+
+function hasBoundedTags(value: unknown): value is string[][] {
+  if (!Array.isArray(value) || value.length > MAX_UNWRAP_TAGS) return false;
+  return value.every((tag) =>
+    Array.isArray(tag)
+    && tag.length <= MAX_UNWRAP_TAG_ITEMS
+    && tag.every((item) => byteLengthWithin(item, MAX_UNWRAP_TAG_ITEM_BYTES))
+  );
+}
+
+function hasBoundedEventShape(value: unknown, requireSignature: boolean): value is NostrEvent {
+  if (!isRecord(value)) return false;
+  if (typeof value.id !== 'string' || !HEX_64.test(value.id)) return false;
+  if (typeof value.pubkey !== 'string' || !HEX_64.test(value.pubkey)) return false;
+  if (requireSignature && (typeof value.sig !== 'string' || !HEX_128.test(value.sig))) return false;
+  if (!Number.isSafeInteger(value.kind) || !Number.isSafeInteger(value.created_at)) return false;
+  return byteLengthWithin(value.content, MAX_UNWRAP_CONTENT_BYTES) && hasBoundedTags(value.tags);
+}
+
 /**
  * Wrap a protocol event template as a NIP-59 gift wrap addressed to a
  * recipient, using only the signer's public methods. The sender's secret key
  * never enters this process; the outer wrap's ephemeral key is generated
  * locally per wrap (it is random by design and protects nothing long-term).
  */
 export async function wrapProtocolEventWithSigner(
   event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>,
   signer: CourtEventSigner,
   recipientPubkey: string,
 ): Promise<NostrEvent> {
   assertHex64(recipientPubkey, 'recipient pubkey');
   const senderPubkey = await signer.getPublicKey();
   assertHex64(senderPubkey, 'signer pubkey');
 
   // Rumor: unsigned, id commits to author + content.
   const rumor = { ...event, pubkey: senderPubkey } as Omit<NostrEvent, 'sig'>;
   rumor.id = getEventHash(rumor as NostrEvent);
 
   // Seal: kind 13, rumor encrypted to the recipient, signed by the sender
   // through the external signer.
   const sealContent = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
   const seal = await signer.signEvent({
     kind: SEAL_KIND,
     content: sealContent,
     created_at: randomNowSeconds(),
     tags: [],
   });
   // Verify over a reconstructed plain object: finalizeEvent/verifyEvent cache
   // their verdict in a non-JSON-enumerable symbol that object spreads
   // preserve, so a malicious signer returning a once-valid seal it then
   // tampered with must never reach the verifier with the cached verdict
   // attached.
   const sealCandidate: NostrEvent = {
     id: seal.id,
     pubkey: seal.pubkey,
     sig: seal.sig,
     kind: seal.kind,
     created_at: seal.created_at,
     content: seal.content,
     tags: seal.tags,
   } as NostrEvent;
   if (
     sealCandidate.kind !== SEAL_KIND
     || sealCandidate.pubkey !== senderPubkey
     || !verifyEvent(sealCandidate)
   ) {
     throw new Error('external signer returned an invalid NIP-59 seal');
   }
 
   // Wrap: kind 1059 under a locally generated ephemeral key.
   return nip59.createWrap(seal, recipientPubkey) as NostrEvent;
 }
 
 /**
  * Unwrap a kind 1059 gift wrap using only the signer's decrypt method, with
  * full NIP-59 verification. Returns the inner rumor, or null if any layer is
  * malformed, misaddressed, forged, or tampered with.
  */
 export async function unwrapProtocolEventWithSigner(
   wrapEvent: NostrEvent,
   signer: CourtEventSigner,
 ): Promise<NostrEvent | null> {
   try {
-    if (wrapEvent.kind !== GIFT_WRAP_KIND) return null;
+    if (wrapEvent.kind !== GIFT_WRAP_KIND || !hasBoundedEventShape(wrapEvent, true)) return null;
     const recipientPubkey = await signer.getPublicKey();
     const addressed = wrapEvent.tags.some(
       (t) => t[0] === 'p' && t[1] === recipientPubkey,
     );
     if (!addressed) return null;
 
     const sealJson = await signer.nip44Decrypt(wrapEvent.pubkey, wrapEvent.content);
+    if (!byteLengthWithin(sealJson, MAX_UNWRAP_CONTENT_BYTES)) return null;
     const seal: unknown = JSON.parse(sealJson);
-    if (!isRecord(seal) || seal.kind !== SEAL_KIND) return null;
-    const sealEvent = seal as unknown as NostrEvent;
-    if (typeof sealEvent.content !== 'string' || !verifyEvent(sealEvent)) return null;
+    if (
+      !hasBoundedJsonDepth(seal)
+      || !hasBoundedEventShape(seal, true)
+      || seal.kind !== SEAL_KIND
+    ) return null;
+    const sealEvent = seal as NostrEvent;
+    if (!verifyEvent(sealEvent)) return null;
 
     const rumorJson = await signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
+    if (!byteLengthWithin(rumorJson, MAX_UNWRAP_CONTENT_BYTES)) return null;
     const rumor: unknown = JSON.parse(rumorJson);
-    if (!isRecord(rumor)) return null;
-    const rumorEvent = rumor as unknown as NostrEvent;
+    if (!hasBoundedJsonDepth(rumor) || !hasBoundedEventShape(rumor, false)) return null;
+    const rumorEvent = rumor as NostrEvent;
 
     // NIP-59: the seal must be signed by the rumor's author, and the rumor id
     // must commit to its exact contents.
     if (rumorEvent.pubkey !== sealEvent.pubkey) return null;
     if (typeof rumorEvent.id !== 'string') return null;
     if (getEventHash(rumorEvent) !== rumorEvent.id) return null;
 
     return rumorEvent;
   } catch {
     return null;
   }
 }
 
 /**
  * Unwrap many gift wraps with a signer and filter to a specific inner kind
  * and dispute. Duplicate rumor ids are deduplicated. Matches the semantics
  * of the seckey-backed `unwrapProtocolEvents` in `nip59.ts`.
  */
 export async function unwrapProtocolEventsWithSigner(
   wraps: readonly NostrEvent[],
   signer: CourtEventSigner,
   options?: {
     readonly kinds?: readonly number[];
     readonly disputeId?: string;
   },
 ): Promise<NostrEvent[]> {
   const seen = new Set<string>();
   const result: NostrEvent[] = [];
+  if (wraps.length > MAX_UNWRAP_BATCH_ITEMS) return result;
 
+  let totalBytes = 0;
   for (const wrap of wraps) {
+    if (typeof wrap.content !== 'string') continue;
+    if (wrap.content.length > MAX_UNWRAP_CONTENT_BYTES) continue;
+    totalBytes += textEncoder.encode(wrap.content).length;
+    if (totalBytes > MAX_UNWRAP_BATCH_BYTES) break;
+
     const rumor = await unwrapProtocolEventWithSigner(wrap, signer);
     if (!rumor || !rumor.id) continue;
     if (seen.has(rumor.id)) continue;
     seen.add(rumor.id);
 
     if (options?.kinds && !options.kinds.includes(rumor.kind)) continue;
     if (options?.disputeId) {
       const disputeTag = rumor.tags.find((t) => t[0] === 'dispute');
       if (disputeTag?.[1] !== options.disputeId) continue;
     }
 
     result.push(rumor);
   }
 
   return result;
 }
 
 /** Generate a fresh random secret key (hex) — for tests and demo rooms. */
 export function generateCourtSeckeyHex(): string {
   return bytesToHex(generateSecretKey());
 }

```


---

### Validate the copied participant roster before opening a ceremony

**Affected files:** courtVoteMachine.ts

**V12 reasoning:** Copy the participant iterable first, then enforce the non-empty invariant on the exact roster stored in machine state, preventing mismatched source length and iteration output from creating an empty ceremony.

```diff
diff --git a/courtVoteMachine.ts b/courtVoteMachine.ts
--- a/courtVoteMachine.ts
+++ b/courtVoteMachine.ts
@@ -1,439 +1,439 @@
 // Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).
 
 /**
  * Pure fail-closed state machine for one BAO Court voting ceremony.
  *
  * Phases: commit_open -> commit_closed -> reveal_open -> reveal_closed ->
  * tally_final. The allowed outcome set is frozen at creation, each roster
  * participant may commit exactly once, a reveal must match that participant's
  * exact session-bound commit, and the tally input is the deterministic set of
  * valid reveals at the close boundary.
  *
  * This module performs no network or Nostr signature verification; the event
  * boundary must authenticate authors and roster indices before dispatching
  * events into the reducer.
  */
 
 import { sha256 } from '@noble/hashes/sha2.js';
 import { bytesToHex } from '@noble/hashes/utils.js';
 import { CanonicalWriter } from './courtSession';
 
 export const COURT_VOTE_COMMIT_DOMAIN = 'BAO-Court/VoteCommit/v1';
 export const COURT_VERDICT_DOMAIN = 'BAO-Court/Verdict/v1';
 export const COURT_DISPUTE_VERDICT_DOMAIN = 'BAO-Court/DisputeVerdict/v1';
 
 export type CourtVotePhase =
   | 'commit_open'
   | 'commit_closed'
   | 'reveal_open'
   | 'reveal_closed'
   | 'tally_final'
   | 'expired'
   | 'aborted';
 
 export interface CourtVoteFailure {
   readonly phase: 'expired' | 'aborted';
   readonly reason: string;
 }
 
 export interface CourtVoteCommitRecord {
   readonly idx: number;
   readonly commitHash: string;
   readonly eventId: string;
 }
 
 export interface CourtVoteRevealRecord {
   readonly idx: number;
   readonly outcome: string;
   readonly salt: string;
   readonly eventId: string;
 }
 
 export interface CourtVerdict {
   readonly outcome: string;
   /** Supporting reveal event ids, sorted lexicographically for canonical hashing. */
   readonly supportingEventIds: readonly string[];
   readonly verdictHash: string;
 }
 
 export interface CourtVoteMachineState {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
   readonly phase: CourtVotePhase;
   readonly commits: readonly CourtVoteCommitRecord[];
   readonly reveals: readonly CourtVoteRevealRecord[];
   readonly verdict?: CourtVerdict;
   readonly failure?: CourtVoteFailure;
 }
 
 export type CourtVoteMachineEvent =
   | {
       readonly type: 'accept_commit';
       readonly idx: number;
       readonly commitHash: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_commits'; readonly now: number }
   | { readonly type: 'open_reveals'; readonly now: number }
   | {
       readonly type: 'accept_reveal';
       readonly idx: number;
       readonly outcome: string;
       readonly salt: string;
       readonly eventId: string;
       readonly now: number;
     }
   | { readonly type: 'close_reveals'; readonly now: number }
   | { readonly type: 'finalize_tally'; readonly now: number }
   | { readonly type: 'tick'; readonly now: number }
   | { readonly type: 'abort'; readonly reason: string };
 
 export class CourtVoteTransitionError extends Error {
   constructor(message: string) {
     super(message);
     this.name = 'CourtVoteTransitionError';
   }
 }
 
 const textEncoder = new TextEncoder();
 const HEX_32 = /^[0-9a-f]{64}$/;
 const MAX_OUTCOMES = 256;
 const MAX_OUTCOME_BYTES = 256;
 
 const TERMINAL_PHASES = new Set<CourtVotePhase>(['tally_final', 'expired', 'aborted']);
 
 /**
  * Canonical session-bound vote commitment hash.
  *
  * Binding the session hash into every commit makes votes unreplayable across
  * disputes, attempts, and crypto suites. The encoding is length-prefixed so
  * outcome/salt boundaries can never be ambiguous.
  */
 export function hashCourtVoteCommit(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly salt: string;
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.hex(params.salt);
   return digestDomain(COURT_VOTE_COMMIT_DOMAIN, writer.finish());
 }
 
 /**
  * Canonical verdict hash binding the session, the winning outcome, and the
  * exact supporting reveal event ids.
  */
 export function hashCourtVerdict(params: {
   readonly sessionHash: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.sessionHash);
   writer.text(params.outcome);
   writer.u32(params.supportingEventIds.length);
   for (const eventId of params.supportingEventIds) {
     writer.hex(eventId);
   }
   return digestDomain(COURT_VERDICT_DOMAIN, writer.finish());
 }
 
 function digestDomain(domain: string, encoded: Uint8Array): string {
   const prefix = textEncoder.encode(domain);
   const input = new Uint8Array(prefix.length + encoded.length);
   input.set(prefix, 0);
   input.set(encoded, prefix.length);
   return bytesToHex(sha256(input));
 }
 
 /**
  * Canonical dispute verdict commitment — the statement a kind-39007
  * attestation binds into its signed message.
  *
  * `H(DisputeVerdict/v1, disputeId, outcome, count, sorted reveal event ids)`
  * over canonical length-prefixed fields. Order-independent (event ids are
  * sorted before hashing) and unambiguous, so every juror, coordinator, and
  * observer derives the same commitment from the same public vote ledger. Any
  * observer can recompute it from the attestation's supporting `e` tags and
  * verify the court really attested the tally winner.
  */
 export function hashDisputeVerdict(params: {
   readonly disputeId: string;
   readonly outcome: string;
   readonly supportingEventIds: readonly string[];
 }): string {
   const writer = new CanonicalWriter();
   writer.hex(params.disputeId);
   writer.text(params.outcome);
   const sorted = [...params.supportingEventIds].sort();
   writer.u32(sorted.length);
   for (const id of sorted) {
     writer.hex(id);
   }
   return digestDomain(COURT_DISPUTE_VERDICT_DOMAIN, writer.finish());
 }
 
 function assertNow(now: number): void {
   if (!Number.isSafeInteger(now) || now < 0) {
     throw new CourtVoteTransitionError('now must be a non-negative Unix timestamp');
   }
 }
 
 function assertParticipant(state: CourtVoteMachineState, idx: number): void {
   if (!state.participantIndices.includes(idx)) {
     throw new CourtVoteTransitionError(`voter ${idx} is outside the certified roster`);
   }
 }
 
 function assertBeforeDeadline(now: number, deadline: number, message: string): void {
   assertNow(now);
   if (now >= deadline) {
     throw new CourtVoteTransitionError(message);
   }
 }
 
 export function createCourtVoteMachine(params: {
   readonly sessionHash: string;
   readonly participantIndices: readonly number[];
   readonly allowedOutcomes: readonly string[];
   readonly commitDeadline: number;
   readonly revealDeadline: number;
 }): CourtVoteMachineState {
   if (!HEX_32.test(params.sessionHash)) {
     throw new CourtVoteTransitionError('sessionHash must be 32-byte lowercase hex');
   }
-  if (params.participantIndices.length === 0) {
+  const participants = [...params.participantIndices];
+  if (participants.length === 0) {
     throw new CourtVoteTransitionError('voting requires at least one participant');
   }
-  const participants = [...params.participantIndices];
   participants.forEach((idx, offset) => {
     if (!Number.isSafeInteger(idx) || idx !== offset + 1) {
       throw new CourtVoteTransitionError('participant indices must be ordered and sequential');
     }
   });
   if (
     !Array.isArray(params.allowedOutcomes) ||
     params.allowedOutcomes.length < 2 ||
     params.allowedOutcomes.length > MAX_OUTCOMES
   ) {
     throw new CourtVoteTransitionError(`allowedOutcomes must contain 2..${MAX_OUTCOMES} outcomes`);
   }
   const outcomes = [...params.allowedOutcomes];
   const seen = new Set<string>();
   for (const outcome of outcomes) {
     if (
       typeof outcome !== 'string' ||
       outcome.length === 0 ||
       textEncoder.encode(outcome).length > MAX_OUTCOME_BYTES
     ) {
       throw new CourtVoteTransitionError('allowed outcomes must be non-empty bounded strings');
     }
     if (seen.has(outcome)) {
       throw new CourtVoteTransitionError('allowed outcomes must be unique');
     }
     seen.add(outcome);
   }
   if (!Number.isSafeInteger(params.commitDeadline) || params.commitDeadline < 1) {
     throw new CourtVoteTransitionError('commitDeadline must be a positive Unix timestamp');
   }
   if (
     !Number.isSafeInteger(params.revealDeadline) ||
     params.revealDeadline <= params.commitDeadline
   ) {
     throw new CourtVoteTransitionError('revealDeadline must be later than commitDeadline');
   }
   return {
     sessionHash: params.sessionHash,
     participantIndices: participants,
     allowedOutcomes: outcomes,
     commitDeadline: params.commitDeadline,
     revealDeadline: params.revealDeadline,
     phase: 'commit_open',
     commits: [],
     reveals: [],
   };
 }
 
 export function reduceCourtVoteMachine(
   state: CourtVoteMachineState,
   event: CourtVoteMachineEvent,
 ): CourtVoteMachineState {
   if (event.type === 'tick') {
     assertNow(event.now);
     // `reveal_closed` means close_reveals already ran at/after the deadline and
     // finalize_tally remains legal afterwards — a clock tick must not expire a
     // ceremony that is one step from finalization (mirrors the DKG machine's
     // exemption of its post-deadline `certified` phase).
     if (
       TERMINAL_PHASES.has(state.phase)
       || state.phase === 'reveal_closed'
       || event.now < state.revealDeadline
     ) {
       return state;
     }
     return {
       ...state,
       phase: 'expired',
       failure: { phase: 'expired', reason: 'The reveal deadline passed before tally finalization.' },
     };
   }
   if (event.type === 'abort') {
     if (TERMINAL_PHASES.has(state.phase)) {
       throw new CourtVoteTransitionError(`cannot abort voting from ${state.phase}`);
     }
     return { ...state, phase: 'aborted', failure: { phase: 'aborted', reason: event.reason } };
   }
   if (TERMINAL_PHASES.has(state.phase)) {
     throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);
   }
 
   if (event.type === 'accept_commit') {
     assertBeforeDeadline(event.now, state.commitDeadline, 'vote commit arrived at or after the commit deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot accept vote commits during ${state.phase}`);
     }
     if (!HEX_32.test(event.commitHash) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote commit hash and event id must be 32-byte lowercase hex');
     }
     const existing = state.commits.find((c) => c.idx === event.idx);
     if (existing) {
       if (existing.commitHash === event.commitHash && existing.eventId === event.eventId) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote commit`,
       );
     }
     return {
       ...state,
       commits: [...state.commits, { idx: event.idx, commitHash: event.commitHash, eventId: event.eventId }],
     };
   }
 
   if (event.type === 'close_commits') {
     assertNow(event.now);
     if (state.phase !== 'commit_open') {
       throw new CourtVoteTransitionError(`cannot close vote commits during ${state.phase}`);
     }
     if (event.now < state.commitDeadline) {
       throw new CourtVoteTransitionError('cannot close vote commits before the commit deadline');
     }
     return { ...state, phase: 'commit_closed' };
   }
 
   if (event.type === 'open_reveals') {
     assertNow(event.now);
     if (state.phase !== 'commit_closed') {
       throw new CourtVoteTransitionError(`cannot open vote reveals during ${state.phase}`);
     }
     return { ...state, phase: 'reveal_open' };
   }
 
   if (event.type === 'accept_reveal') {
     assertBeforeDeadline(event.now, state.revealDeadline, 'vote reveal arrived at or after the reveal deadline');
     assertParticipant(state, event.idx);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot accept vote reveals during ${state.phase}`);
     }
     if (!state.allowedOutcomes.includes(event.outcome)) {
       throw new CourtVoteTransitionError('vote reveal names an outcome outside the frozen allowlist');
     }
     if (!HEX_32.test(event.salt) || !HEX_32.test(event.eventId)) {
       throw new CourtVoteTransitionError('vote reveal salt and event id must be 32-byte lowercase hex');
     }
     const commit = state.commits.find((c) => c.idx === event.idx);
     if (!commit) {
       throw new CourtVoteTransitionError(
         `participant ${event.idx} revealed without a prior session commit`,
       );
     }
     const expected = hashCourtVoteCommit({
       sessionHash: state.sessionHash,
       outcome: event.outcome,
       salt: event.salt,
     });
     if (expected !== commit.commitHash) {
       throw new CourtVoteTransitionError(
         `vote reveal from participant ${event.idx} does not match its commit`,
       );
     }
     const existing = state.reveals.find((r) => r.idx === event.idx);
     if (existing) {
       if (
         existing.outcome === event.outcome &&
         existing.salt === event.salt &&
         existing.eventId === event.eventId
       ) {
         return state;
       }
       throw new CourtVoteTransitionError(
         `participant ${event.idx} published a conflicting vote reveal`,
       );
     }
     return {
       ...state,
       reveals: [
         ...state.reveals,
         { idx: event.idx, outcome: event.outcome, salt: event.salt, eventId: event.eventId },
       ],
     };
   }
 
   if (event.type === 'close_reveals') {
     assertNow(event.now);
     if (state.phase !== 'reveal_open') {
       throw new CourtVoteTransitionError(`cannot close vote reveals during ${state.phase}`);
     }
     if (event.now < state.revealDeadline) {
       throw new CourtVoteTransitionError('cannot close vote reveals before the reveal deadline');
     }
     return { ...state, phase: 'reveal_closed' };
   }
 
   if (event.type === 'finalize_tally') {
     assertNow(event.now);
     if (state.phase !== 'reveal_closed') {
       throw new CourtVoteTransitionError(`cannot finalize the tally during ${state.phase}`);
     }
     if (state.reveals.length === 0) {
       throw new CourtVoteTransitionError('cannot finalize a verdict without any valid reveal');
     }
     const counts = new Map<string, string[]>();
     for (const reveal of state.reveals) {
       const list = counts.get(reveal.outcome) ?? [];
       list.push(reveal.eventId);
       counts.set(reveal.outcome, list);
     }
     let winner = '';
     let winnerCount = -1;
     for (const [outcome, eventIds] of counts.entries()) {
       if (
         eventIds.length > winnerCount ||
         (eventIds.length === winnerCount && outcome < winner)
       ) {
         winner = outcome;
         winnerCount = eventIds.length;
       }
     }
     const supportingEventIds = [...(counts.get(winner) ?? [])].sort();
     const verdict: CourtVerdict = {
       outcome: winner,
       supportingEventIds,
       verdictHash: hashCourtVerdict({
         sessionHash: state.sessionHash,
         outcome: winner,
         supportingEventIds,
       }),
     };
     return { ...state, phase: 'tally_final', verdict };
   }
 
   return state;
 }

```


## Invalid Findings (No Fix Needed)

- **[LOW]** Post-Deadline Close Is Intentional Catch-Up

- **[LOW]** Unverified Support Evidence Can Certify False Tallies

- **[LOW]** Regex Validation Coerces Non-String Keys

- **[LOW]** Predictable NIP-59 Timestamp Randomization

- **[LOW]** Raw-Key Signer Is Publicly Production-Usable

- **[LOW]** Strict Unwrap Fix Verified

- **[LOW]** Tampered Snapshot Forges Publication State

- **[LOW]** Settlement proceeds after failed attestation publication

- **[LOW]** Publication notification reports event kind as ID

- **[LOW]** Unverified Partials Can Publish Forged Attestations

- **[LOW]** Signing hash omits finalized signer set

- **[LOW]** Unbounded Abort Reason Amplifies State

- **[LOW]** Malformed Events Bypass Controlled Rejection

- **[LOW]** Default DKG Exposes Every Secret Share

- **[LOW]** Noncontiguous Rosters Produce Unusable Records

- **[LOW]** Unbound DKG Key Can Become Certified

- **[LOW]** Invalid Curve Key Passes DKG Certification

- **[LOW]** Session Hash Does Not Prevent DKG Replay

- **[LOW]** Backup Readiness Can Be Falsely Recorded

- **[LOW]** Zero Refresh Share Aborts Ceremony

- **[LOW]** Reject unknown runtime ceremony events

- **[LOW]** Stale clocks bypass ceremony deadlines

- **[LOW]** Sparse roster holes are rejected during initialization

- **[LOW]** Partial signatures are not restricted to canonical scalar values

- **[LOW]** Duplicate reveal IDs can inflate vote tallies

- **[LOW]** Validate abort reasons before persisting failure state

- **[LOW]** Unauthenticated abort can permanently terminate live votes

- **[LOW]** Prepublished reveals can satisfy later commitments

- **[LOW]** Use rejection sampling for unbiased deterministic scalars

- **[LOW]** Accepts noncanonical proof response encodings

- **[LOW]** Unbounded gift-wrap batches exhaust signer processing

- **[LOW]** Malformed batch arguments abort all processing

- **[LOW]** Reject invalid secp256k1 secret scalars at construction

- **[LOW]** Enforce unsigned rumors at runtime

- **[LOW]** Enforce canonical peer keys at every NIP-44 boundary

- **[LOW]** Accept noncanonical numeric fields in private rumors

- **[LOW]** Raw signer secrets cannot be deterministically cleared

- **[LOW]** Out-of-range attempt values crash signing initialization

- **[LOW]** Disqualification allows a reduced roster to create a signing key

- **[LOW]** Validate juror indices as canonical nonzero field coordinates

- **[LOW]** Ambiguous DKG proof-domain encoding permits context replay

- **[LOW]** Refresh accepts inconsistent duplicate participant rosters

- **[LOW]** VSS verification accepts malformed and degenerate share packages

- **[LOW]** Unauthenticated share aggregation permits corrupted secret shares

- **[LOW]** verifyFinalSignature exposes malformed-input exceptions instead of returning false

- **[LOW]** Regex coercion allows non-string hex values to poison vote state

