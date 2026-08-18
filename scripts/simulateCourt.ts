// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `simulate-court` — one-shot end-to-end BAO Court simulation.
 *
 * Drives the full dispute pipeline in a single process, fast, with the
 * in-memory rail fakes (no network, no credentials):
 *
 *   jury pool → deterministic selection → Pedersen DKG → commit/reveal vote
 *   → tally → FROST threshold signing → attestation validation → escrow
 *   ledger + slashing plan → Lightning hold decisions (LnRail fake) →
 *   Liquid escrow script/address/skeleton (LiquidRail fake) → report.
 *
 * Run:   npm run simulate:court
 * Test:  the same pipeline is asserted in `__tests__/simulateCourt.test.ts`.
 *
 * This is the "test the whole court in one script, fast" harness: every step
 * is deterministic given the seed, and the rail fakes keep it hermetic.
 */

import { selectJuryWithBackups } from '../selection';
import { PedersenDkgAdapter } from '../dkg';
import { hashCommit, tallyVotes, deriveSimulatedRevealEventId } from '../dispute';
import { hashDisputeVerdict } from '../courtVoteMachine';
import type { JurorVote } from '../types';
import { createCommitments, createRevealsAndPartialSigs, aggregateAttestation, InMemoryNonceGuard } from '../signing';
import { validateAttestationEvent } from '../validator';
import type { JurorProfile } from '../types';
import {
  computeRedistributionPlan,
  verifyRedistributionIntegrity,
  EscrowLedger,
  deriveXOnlyPubkey,
} from '../index';
import { LnHoldLedger, planDecisionsForHolds, constructHoldOffer } from '../lnSettlement';
import { createFakeLnRail, applyLnDecision } from '../lnRail';
import { buildMultisigScript, p2wshAddress, buildReleaseSkeleton, p2wshProgram, BAO_SIGNET } from '../liquidEscrow';
import { createFakeLiquidRail, chooseSpendBranch } from '../liquidRail';
import { scalarToHex, seededScalar } from '../crypto';
import { BAO_COURT_ATTESTATION_KIND } from '../events';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { fileURLToPath } from 'node:url';

// ── Deterministic jury pool ─────────────────────────────────────────────────

/**
 * Deterministic nominee pool. Seckeys are derived with `seededScalar` from
 * the simulation seed so the whole run is reproducible (same seed → same
 * pool → same selection → same group key). Test-harness only — production
 * keys must come from `randomScalar`.
 */
function nomineePool(size: number, seedHex: string): JurorProfile[] {
  const seedBytes = hexToBytes(seedHex);
  const enc = new TextEncoder();
  const pool: JurorProfile[] = [];
  for (let i = 0; i < size; i++) {
    const seckey = scalarToHex(seededScalar(seedBytes, enc.encode(`bao-court-sim/pool/${i}`)));
    pool.push({
      nostrPubkey: deriveXOnlyPubkey(seckey),
      stakeCapacitySats: 20_000 + i * 1_000,
      wotScore: 80 + (i % 21),
      categories: ['sports'],
      registeredAt: 1_700_000_000,
      stakeCommitment: {
        amountSats: 20_000 + i * 1_000,
        bondAddress: `fake-addr-${i}`,
        // Candidates enter the selection pool already pledged: selection
        // (filterEligibleJurors) only admits confirmed stake commitments.
        status: 'confirmed',
      },
    });
  }
  return pool;
}

function calculateBond(volumeSats: number): number {
  return Math.max(Math.floor(volumeSats * 0.05), 10_000);
}

// ── Simulation ──────────────────────────────────────────────────────────────

export interface StepResult {
  readonly step: string;
  readonly detail: string;
  readonly ok: boolean;
}

export interface SimulationOutcome {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<StepResult>;
  readonly selectedCount: number;
  readonly groupPubkeyXOnly: string;
  readonly attestationValid: boolean;
  readonly slashedPoolSats: number;
  readonly lnSettled: number;
  readonly lnCancelled: number;
  readonly liquidAddress: string;
  readonly broadcastTxid: string | null;
}

export async function runCourtSimulation(
  opts: {
    readonly poolSize?: number;
    readonly jurySize?: number;
    readonly backups?: number;
    readonly seed?: string;
  } = {},
): Promise<SimulationOutcome> {
  const steps: StepResult[] = [];
  const push = (step: string, detail: string, ok: boolean) => steps.push({ step, detail, ok });

  const poolSize = opts.poolSize ?? 12;
  const jurySize = opts.jurySize ?? 5;
  const backups = opts.backups ?? 2;
  // selection requires 32-byte (64-hex) ids/hashes — derive a hex id from the seed
  const seedHex = Array.from(opts.seed ?? 'demo')
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padEnd(64, 'd')
    .slice(0, 64);
  const disputeId = seedHex;
  const marketId = `market-${opts.seed ?? 'demo'}`;
  const blockHash = 'f'.repeat(64);
  const threshold = Math.ceil((jurySize * 2) / 3); // ~2/3
  const stakePerJuror = 10_000;
  const bondAmount = calculateBond(1_000_000);

  try {
    // 1. Deterministic selection with backups.
    const pool = nomineePool(poolSize, seedHex);
    const { selected, backups: backupList } = selectJuryWithBackups(pool, {
      disputeEventId: disputeId,
      blockHash,
      marketCategory: 'sports',
      marketVolumeSats: 1_000_000,
      jurySize,
      backupCount: backups,
    });
    push('selection', `selected ${selected.length}/${poolSize} (${backupList.length} backups)`, selected.length === jurySize);

    // 2. Pedersen DKG (threshold ~2/3).
    // unsafeTestMode + seed make the ceremony reproducible for the sim.
    // This is forbidden in production: a shared seed lets any juror
    // reconstruct the group secret (enforced by the adapter itself).
    const keygen = new PedersenDkgAdapter({ unsafeTestMode: true }).run({
      marketId,
      disputeId,
      threshold,
      jurors: selected,
      seed: seedHex,
    });
    push('dkg', `threshold ${threshold}/${keygen.record.participants}, group ${keygen.record.groupPubkeyXOnly.slice(0, 12)}…`, keygen.record.participants === jurySize);

    // 3. Commit/reveal vote — juror idx 1 votes incoherently (slashing coverage).
    const outcome = 'YES';
    const votes: JurorVote[] = selected.map((j) => {
      const voted = j.idx === 1 ? 'NO' : outcome;
      const salt = `${disputeId}:${j.idx}`;
      return { idx: j.idx, pubkey: j.nostrPubkey, commit: hashCommit(voted, salt), reveal: { outcome: voted, salt } };
    });
    const tally = tallyVotes(votes);
    push('vote', `winner=${tally.outcome}, supporting=${tally.supportingVotes.length}, invalid=${tally.invalidReveals.length}`, tally.outcome === outcome);

    // 4. FROST signing by the coherent (majority) jurors — dispute-bound,
    // so the attestation is a Kind 39007 dispute override (not Kind 89). The
    // signed message binds the dispute verdict commitment: the court certifies
    // the TALLY winner, not just an outcome.
    const coherent = votes.filter((v) => v.reveal?.outcome === tally.outcome);
    const coherentShares = keygen.shares.filter((s) => coherent.some((v) => v.idx === s.idx));
    if (coherentShares.length < threshold) throw new Error('not enough coherent signers');
    const supportingEventIds = tally.supportingVotes.map((v) =>
      deriveSimulatedRevealEventId(v.idx, v.reveal!.outcome, v.reveal!.salt),
    );
    const verdictHash = hashDisputeVerdict({ disputeId, outcome: tally.outcome, supportingEventIds });
    const signingParams = { marketId, outcome: tally.outcome, round: 1, disputeEventId: disputeId, verdictHash, dkg: keygen.record, shares: coherentShares };
    const nonceGuard = new InMemoryNonceGuard();
    const commitments = createCommitments(coherentShares);
    const reveals = createRevealsAndPartialSigs({ ...signingParams, nonceGuard }, commitments);
    const attestation = aggregateAttestation({ ...signingParams, nonceGuard }, commitments, reveals);
    const disputeAttestation = { ...attestation, verdictHash, supportingEventIds };
    push('sign', `attestation sig ${attestation.signature.slice(0, 16)}… (kind ${attestation.kind})`, attestation.kind === BAO_COURT_ATTESTATION_KIND);

    // 5. Attestation validation: publish a REAL, well-formed Nostr event
    // (finalizeEvent signs the wrapper; the FROST group sig rides in tags)
    // and run the production validator against it with full context.
    const publisherSeckey = hexToBytes(
      scalarToHex(seededScalar(hexToBytes(seedHex), new TextEncoder().encode('bao-court-sim/publisher'))),
    );
    const event = finalizeEvent({
      kind: BAO_COURT_ATTESTATION_KIND,
      created_at: 1_700_000_000,
      tags: [
        ['e', disputeId, '', 'root'],
        ['m', marketId],
        ['p', attestation.groupPubkey],
        ['outcome', attestation.outcome],
        ['round', String(attestation.round)],
        ['nonce', attestation.pubNonce],
        ['sig', attestation.signature],
        ['ver', 'FROST-BIP340-v1'],
        ['dispute', disputeId],
        ['verdict', verdictHash],
        ...supportingEventIds.map((id) => ['e', id, '', 'mention'] as [string, string, string, string]),
      ],
      content: JSON.stringify({
        marketId,
        outcome: attestation.outcome,
        round: String(attestation.round),
        message: attestation.message,
        disputeEventId: disputeId,
        verdictHash,
        supportingEventIds,
      }),
    }, publisherSeckey);
    const validation = validateAttestationEvent(event, {
      expectedGroupPubkey: keygen.record.groupPubkeyXOnly,
      expectedDisputeEventId: disputeId,
      expectedMarketId: marketId,
      allowedOutcomes: ['YES', 'NO'],
    });
    push('validate', `attestation valid=${validation.valid}${validation.error ? ` (${validation.error})` : ''}`, validation.valid);

    // 6. Escrow ledger + slashing plan.
    const ledger = new EscrowLedger();
    for (const j of selected) {
      const id = `${disputeId}|juror_stake|${j.nostrPubkey}`;
      ledger.record({ marketId, disputeId, round: 1, purpose: 'juror_stake', depositorPubkey: j.nostrPubkey, amountSats: stakePerJuror, bondAddress: `escrow-${j.idx}`, committedAt: 1_700_000_000 });
      ledger.lock(id, true);
    }
    const bondRec = ledger.record({ marketId, disputeId, round: 1, purpose: 'dispute_bond', depositorPubkey: 'challenger', amountSats: bondAmount, bondAddress: 'bond-addr', committedAt: 1_700_000_000 });
    ledger.lock(bondRec.id, true);

    const coherentPubkeys = coherent.map((v) => v.pubkey);
    const incoherentPubkeys = votes.filter((v) => v.reveal?.outcome !== tally.outcome).map((v) => v.pubkey);
    const plan = computeRedistributionPlan({
      marketId, disputeId, round: 1, stakePerJuror,
      coherentJurors: coherentPubkeys,
      incoherentJurors: incoherentPubkeys,
      nonRevealJurors: [],
      disputeUpheld: true, bondAmount, disputerPubkey: 'challenger',
    });
    const integrity = verifyRedistributionIntegrity(plan);
    push('escrow', `slashPool=${plan.slashedPool} sats, integrity=${integrity.valid}`, integrity.valid);

    // 7. Lightning hold invoices: offers are registered with the rail FIRST
    // (invoice id comes back), then recorded in the protocol ledger; coherent
    // jurors settle (preimage released), incoherent are cancelled.
    const ln = new LnHoldLedger();
    const lnRail = createFakeLnRail().rail;
    for (const j of selected) {
      const construction = {
        disputeId, role: 'juror' as const, pubkey: j.nostrPubkey,
        outcome: tally.outcome, attestationDigest: attestation.message,
        round: 1, amountSats: stakePerJuror, expiresAt: 3_000_000_000,
      };
      const offerRec = constructHoldOffer(construction);
      const { invoiceId } = await lnRail.createHoldInvoice({
        paymentHash: offerRec.paymentHash,
        amountSats: offerRec.amountSats,
        memo: `BAO Court hold ${offerRec.id}`,
        expiresAt: offerRec.expiresAt,
      });
      ln.offer({ ...construction, invoiceId });
      ln.hold(offerRec.id, 2_500_000_000);
    }
    const holds = ln.all();
    const { decisions } = planDecisionsForHolds(plan, holds);
    let settled = 0; let cancelled = 0;
    for (const h of holds) {
      const d = decisions[h.id] ?? 'cancel';
      await applyLnDecision(lnRail, h, d);
      ln.decide(h.id, d, 2_600_000_000);
      if (d === 'settle') settled++; else cancelled++;
    }
    push('ln', `settled=${settled} coherent, cancelled=${cancelled} incoherent`, settled === coherentCountOf(votes) && settled + cancelled === holds.length);

    // 8. Liquid: 2-of-3 escrow over the first three selected pubkeys + release skeleton.
    const top3Pubkeys = selected.slice(0, 3).map((j) => j.nostrPubkey);
    const script = buildMultisigScript({ pubkeys: top3Pubkeys, threshold: 2 });
    const liquidAddr = p2wshAddress(script, BAO_SIGNET);
    const branch = chooseSpendBranch({ disputeUpheld: plan.bondOutcome === 'returned', coherentCount: coherentPubkeys.length });
    const skeleton = buildReleaseSkeleton(
      [{ txid: '41'.repeat(32), vout: 0, amountSats: 1_000_000, scriptHex: script }],
      [{ scriptHex: programHexOf(script), amountSats: 990_000 }],
      5_000,
    );
    const liquidRail = createFakeLiquidRail().rail;
    const txid = await liquidRail.broadcast(`mock-liquid-${branch}-${skeleton.feeSats}`);
    push('liquid', `branch=${branch}, addr=${liquidAddr.slice(0, 12)}…, fee=${skeleton.feeSats}sats, tx=${txid}`, skeleton.feeSats > 0 && !!txid);

    return {
      ok: steps.every((s) => s.ok),
      steps,
      selectedCount: selected.length,
      groupPubkeyXOnly: keygen.record.groupPubkeyXOnly,
      attestationValid: validation.valid,
      slashedPoolSats: plan.slashedPool,
      lnSettled: settled,
      lnCancelled: cancelled,
      liquidAddress: liquidAddr,
      broadcastTxid: txid,
    };
  } catch (err) {
    push('error', (err as Error).message, false);
    return { ok: false, steps, selectedCount: 0, groupPubkeyXOnly: '', attestationValid: false, slashedPoolSats: 0, lnSettled: 0, lnCancelled: 0, liquidAddress: '', broadcastTxid: null };
  }
}

function coherentCountOf(votes: JurorVote[]): number {
  const tally = tallyVotes(votes);
  return votes.filter((v) => v.reveal?.outcome === tally.outcome).length;
}

function programHexOf(scriptHex: string): string {
  return bytesToHex(p2wshProgram(scriptHex));
}

// ── Report ──────────────────────────────────────────────────────────────────

export function printReport(r: SimulationOutcome): void {
  console.log('\n===== BAO COURT SIMULATION =====');
  for (const s of r.steps) {
    console.log(`  [${s.ok ? ' ✔ ' : ' ✕ '}] ${s.step}: ${s.detail}`);
  }
  console.log(`RESULT: ${r.ok ? 'ALL GREEN' : 'FAILED'}`);
  console.log(`  selected=${r.selectedCount} group=${r.groupPubkeyXOnly.slice(0, 12)}… attestation=${r.attestationValid} slashPool=${r.slashedPoolSats}`);
  console.log(`  LN settled=${r.lnSettled} cancelled=${r.lnCancelled} liquid=${r.liquidAddress} tx=${r.broadcastTxid ?? '—'}`);
}

// ── CLI entry (pnpm simulate:court) ─────────────────────────────────────────

// Run only when invoked as the main script. `process` is only referenced
// inside this guard so the module stays browser-safe when imported as a lib.
if (typeof process !== 'undefined' && process.argv?.[1] === fileURLToPath(import.meta.url)) {
  runCourtSimulation().then((r) => { printReport(r); process.exit(r.ok ? 0 : 1); });
}
