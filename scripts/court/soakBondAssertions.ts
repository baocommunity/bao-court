// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * `soakBondAssertions` — the bond-gated scenarios' ASSERTIONS, as pure functions.
 *
 * The soak runner (`distributed-ceremony-soak.mjs`) records one JSONL line per
 * run. That line is only worth writing if a violated expectation FAILS the run,
 * so every expectation about a bond-gated ceremony is expressed here — once —
 * and evaluated against the driver's own artifact:
 *
 *   honest run      signatureVerified:true, exactly one aggregate signature, a
 *                   group key, every admitted seat `bondVerified:true`, and the
 *                   roster's bond references recorded VERBATIM;
 *   negative run    signatureVerified:false, `groupKey:null`, no signature at
 *                   all, the EXPECTED typed refusal code present, the expected
 *                   seats excluded, and the typed `ROSTER_BELOW_THRESHOLD` stop;
 *   every run       zero stray processes, no relay still listening, zero held
 *                   HTLCs (the bond rails here never open one, and a leak would
 *                   be real money held).
 *
 * Nothing here touches the network, the boxes or a chain: it reads the artifact
 * the driver already wrote. That is what makes it testable
 * (`__tests__/soakBondAssertions.test.ts`).
 */

export type BondMode = 'liquid' | 'onchain' | 'wrongseat' | 'unbound' | 'timeout';

export interface BondRef {
  readonly rail: string;
  readonly network: string;
  readonly proofRef: string;
}

export interface BondPlanSeat {
  readonly seat: number;
  readonly box: string;
  readonly jurorPubkey: string;
  readonly liquid: string;
  readonly onchain: string;
}

export interface BondPlan {
  readonly bondSats: number;
  readonly jurorKeysDir: string;
  readonly boxes: readonly string[];
  readonly liquid: { readonly network: string; readonly courtGroupPubkey: string; readonly asset: string };
  readonly onchain: { readonly network: string; readonly courtPubkey: string; readonly bitcoindSsh: string };
  readonly legacyLiquid: { readonly proofRef: string };
  readonly seats: readonly BondPlanSeat[];
  readonly expectedCodes?: Readonly<Record<BondMode, readonly string[]>>;
}

/** The roster/wire form: `liquid/testnet:<txid>:<vout>`. */
export function formatBondRef(ref: BondRef): string {
  return `${ref.rail}/${ref.network}:${ref.proofRef}`;
}

export interface BondExpectation {
  readonly mode: BondMode;
  /** Bonds in BOX order (index i ⇒ seat i+1) — exactly what the roster carries. */
  readonly bonds: readonly BondRef[];
  readonly admittedSeats: readonly number[];
  readonly excludedSeats: readonly number[];
  /** Typed codes that MUST appear in the artifact (empty ⇒ none expected). */
  readonly codes: readonly string[];
  readonly expectSignature: boolean;
  readonly n: number;
}

/**
 * The bonds each scenario presents, in box order.
 *
 * `wrongseat` presents TWO wrong-seat claims in ONE run — a Liquid bond under
 * another seat's key (`BOND_JUROR_MISMATCH`) and a testnet4 bond under another
 * seat's key (`BOND_SCRIPT_MISMATCH`) — and `leadRail` swaps which of the two
 * sits at seat 1, so the rotation alternates the rail that is refused FIRST
 * while both bindings are exercised every time. One code in one run would leave
 * the other rail's binding unproven by the soak.
 */
export function bondsForMode(
  plan: BondPlan,
  mode: BondMode,
  leadRail: 'liquid' | 'onchain' = 'liquid',
): BondExpectation {
  const n = plan.boxes.length;
  const seats = [...plan.seats].sort((a, b) => a.seat - b.seat);
  if (seats.length !== n) {
    throw new Error(`bond plan names ${seats.length} seat(s) but ${n} box(es): every box needs exactly one bond`);
  }
  const network = { liquid: plan.liquid.network, onchain: plan.onchain.network };
  const ref = (rail: 'liquid' | 'onchain', proofRef: string): BondRef => ({ rail, network: network[rail], proofRef });
  const own = (rail: 'liquid' | 'onchain') => seats.map((s) => ref(rail, s[rail]));
  const allSeats = seats.map((s) => s.seat);
  const codes = plan.expectedCodes?.[mode] ?? [];

  switch (mode) {
    case 'liquid':
      return { mode, bonds: own('liquid'), admittedSeats: allSeats, excludedSeats: [], codes: [], expectSignature: true, n };
    case 'onchain':
      return { mode, bonds: own('onchain'), admittedSeats: allSeats, excludedSeats: [], codes: [], expectSignature: true, n };
    case 'wrongseat': {
      // Seat 1 claims seat 2's bond, seat 2 claims seat 1's bond — on DIFFERENT
      // rails — and seat 3 keeps its own (so the run has one honest admission
      // and the stop is the THRESHOLD, not a total wipe-out).
      const first: BondRef = leadRail === 'liquid'
        ? ref('liquid', seats[1].liquid)
        : ref('onchain', seats[1].onchain);
      const second: BondRef = leadRail === 'liquid'
        ? ref('onchain', seats[0].onchain)
        : ref('liquid', seats[0].liquid);
      return {
        mode,
        bonds: [first, second, ref('liquid', seats[2].liquid)],
        admittedSeats: [seats[2].seat],
        excludedSeats: [seats[0].seat, seats[1].seat],
        codes,
        expectSignature: false,
        n,
      };
    }
    case 'unbound': {
      // The legacy court-only lock commits no juror: it is a real, funded,
      // unspent coin that still cannot back a seat.
      const bonds = own('liquid');
      return {
        mode,
        bonds: [ref('liquid', plan.legacyLiquid.proofRef), ...bonds.slice(1)],
        admittedSeats: allSeats.slice(1),
        excludedSeats: [allSeats[0]],
        codes,
        expectSignature: false,
        n,
      };
    }
    case 'timeout': {
      // The REAL bonds, claimed honestly — the check itself never answers, so
      // every seat must be excluded and the ceremony must stop typed. This is
      // the one scenario whose refusal is about the gate's liveness, not the
      // coin.
      return {
        mode,
        bonds: own('liquid'),
        admittedSeats: [],
        excludedSeats: allSeats,
        codes,
        expectSignature: false,
        n,
      };
    }
    default: {
      const never: never = mode;
      throw new Error(`unknown bond mode ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Artifact shapes (the subset the driver writes; see distributed-ceremony.mjs)
// ---------------------------------------------------------------------------

export interface BondGateVerdict {
  readonly idx: number;
  readonly code?: string | null;
  readonly ok?: boolean;
  readonly proofRef?: string | null;
}

export interface BondIdentity {
  readonly seat?: number;
  readonly idx?: number;
  readonly box?: string;
  readonly bondRef?: string | null;
  readonly bondVerified?: boolean;
  readonly bondCode?: string | null;
  readonly admitted?: boolean;
}

export interface BondGateBlock {
  readonly enforced?: boolean;
  readonly requireBonds?: boolean;
  readonly bondSats?: number;
  /**
   * Seat indices. The driver writes PLAIN NUMBERS in a completed run and the
   * full verdict OBJECTS in a stopped one (the gate's own `admitted`/`excluded`
   * arrays), so both shapes are accepted and normalised here — a record that
   * silently skipped this distinction would compare `[object Object]` to a seat
   * number and call a correct refusal a failure.
   */
  readonly admitted?: ReadonlyArray<number | { readonly idx?: number }>;
  readonly excluded?: ReadonlyArray<number | { readonly idx?: number }>;
  readonly classification?: string | null;
  readonly verdicts?: readonly BondGateVerdict[];
}

/** Normalise `admitted`/`excluded` (numbers or verdict objects) to seat indices. */
export function seatIndices(
  list: ReadonlyArray<number | { readonly idx?: number }> | undefined | null,
): number[] {
  if (!Array.isArray(list)) return [];
  const out: number[] = [];
  for (const entry of list) {
    if (typeof entry === 'number') out.push(entry);
    else if (entry && typeof entry === 'object' && typeof entry.idx === 'number') out.push(entry.idx);
  }
  return out;
}

export interface RunArtifact {
  readonly signatureVerified?: boolean;
  readonly groupKey?: string | null;
  readonly signatures?: readonly string[];
  readonly classification?: string | null;
  readonly classifications?: ReadonlyArray<{ idx: number; classification: string | null }>;
  readonly bondGate?: BondGateBlock | null;
  readonly identities?: readonly BondIdentity[];
}

/**
 * Every expectation for ONE bond-gated run. An empty array means the run did
 * what the scenario claims it proves.
 */
export function assertBondRun(run: RunArtifact | null | undefined, expectation: BondExpectation): string[] {
  const failures: string[] = [];
  if (!run) return ['the driver wrote no run artifact'];
  const fail = (m: string) => failures.push(m);

  const gate = run.bondGate ?? null;
  if (!gate) fail('the artifact carries no bondGate block');
  else if (gate.enforced !== true) fail('bondGate.enforced is not true: the gate did not run');

  const signatures = run.signatures ?? [];

  if (expectation.expectSignature) {
    if (run.signatureVerified !== true) fail('signatureVerified is not true on an honest bond-gated run');
    if (signatures.length !== 1) fail(`expected exactly one aggregate signature, got ${signatures.length}`);
    if (!run.groupKey) fail('groupKey is null on an honest bond-gated run');
    const admittedIndices = seatIndices(gate?.admitted);
    if (gate && admittedIndices.length !== expectation.n) {
      fail(`expected ${expectation.n} admitted seat(s), got ${admittedIndices.length}`);
    }
    const admitted = (run.identities ?? []).filter((i) => i.bondVerified === true || i.admitted === true);
    if (admitted.length !== expectation.n) {
      fail(`expected ${expectation.n} seat(s) with a VERIFIED bond, got ${admitted.length}`);
    }
    for (const identity of run.identities ?? []) {
      const seat = identity.seat ?? identity.idx;
      if (seat === undefined) continue;
      if (identity.bondVerified !== true) fail(`seat ${seat} does not carry bondVerified:true`);
    }
  } else {
    if (run.signatureVerified !== false) fail('signatureVerified is not false on a negative run');
    if (signatures.length !== 0) fail(`a negative run emitted ${signatures.length} signature(s)`);
    if (run.groupKey !== null && run.groupKey !== undefined) fail('groupKey is not null on a negative run');

    const excluded = seatIndices(gate?.excluded);
    if (excluded.length !== expectation.excludedSeats.length) {
      fail(`expected ${expectation.excludedSeats.length} excluded seat(s) (${expectation.excludedSeats.join(',')}), got ${excluded.length}`);
    }
    for (const seat of expectation.excludedSeats) {
      if (!excluded.includes(seat)) fail(`seat ${seat} was expected to be EXCLUDED and was not`);
    }
    const admitted = seatIndices(gate?.admitted);
    for (const seat of expectation.admittedSeats) {
      if (!admitted.includes(seat)) fail(`seat ${seat} was expected to be ADMITTED and was not`);
    }
    const classification = gate?.classification ?? run.classification ?? null;
    if (classification !== 'ROSTER_BELOW_THRESHOLD') {
      fail(`expected the typed stop ROSTER_BELOW_THRESHOLD, got ${String(classification)}`);
    }
  }

  // ── the typed codes, from the artifact (never from a log line) ───────────
  const codesSeen = new Set<string>();
  for (const verdict of gate?.verdicts ?? []) if (verdict.code) codesSeen.add(verdict.code);
  for (const identity of run.identities ?? []) if (identity.bondCode) codesSeen.add(identity.bondCode);
  for (const code of expectation.codes) {
    if (!codesSeen.has(code)) {
      fail(`the expected typed code ${code} is not in the artifact (saw ${[...codesSeen].join(',') || 'none'})`);
    }
  }

  // ── the bond references, VERBATIM ────────────────────────────────────────
  // A record whose refs are normalised, truncated or reordered is not evidence
  // that THIS bond was presented to THIS seat.
  expectation.bonds.forEach((bond, i) => {
    const seat = i + 1;
    const expected = formatBondRef(bond);
    const identity = (run.identities ?? []).find((entry) => (entry.seat ?? entry.idx) === seat);
    if (!identity) fail(`seat ${seat} is missing from the artifact`);
    else if (identity.bondRef !== expected) {
      fail(`seat ${seat} recorded bond ${String(identity.bondRef)} instead of ${expected}`);
    }
    const verdict = (gate?.verdicts ?? []).find((entry) => entry.idx === seat);
    // A `rail:none` seat runs no command; every bond scenario claims a rail.
    if (!verdict) fail(`seat ${seat} has no bond-check verdict in the artifact`);
    else if (verdict.proofRef !== bond.proofRef) {
      fail(`seat ${seat} was checked against ${String(verdict.proofRef)} instead of ${bond.proofRef}`);
    }
  });

  return failures;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export interface BoxCleanup {
  readonly box: string;
  readonly left: number | null;
  readonly listen: number | null;
}

export interface CleanupAssertionInput {
  readonly boxes: readonly BoxCleanup[];
  /** Is anything still listening on the coordinator's relay port? */
  readonly coordinatorListening: boolean;
  /**
   * Held HTLCs seen on the Lightning node, or `null` when the probe could not
   * answer (the rail is not part of this rotation; an absent probe is recorded
   * as unknown, never as zero).
   */
  readonly heldHtlcs: number | null;
}

/** Zero strays, zero listeners, zero held HTLCs — after EVERY run. */
export function assertCleanup(input: CleanupAssertionInput): string[] {
  const failures: string[] = [];
  for (const entry of input.boxes) {
    if (entry.left === null || entry.listen === null) {
      failures.push(`${entry.box}: the cleanup probe did not answer`);
      continue;
    }
    if (entry.left !== 0) failures.push(`${entry.box}: ${entry.left} stray process(es) still running`);
    if (entry.listen !== 0) failures.push(`${entry.box}: something is still listening on the relay port`);
  }
  if (input.coordinatorListening) failures.push('the coordinator still has the relay port open');
  if (input.heldHtlcs !== null && input.heldHtlcs !== 0) {
    failures.push(`${input.heldHtlcs} HTLC(s) still held on the Lightning node`);
  }
  return failures;
}
