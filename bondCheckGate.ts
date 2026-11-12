// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * The CEREMONY's bond gate — turning `CourtBondRef` from a claim into a seat
 * requirement.
 *
 * `bondVerification.ts` carries the roster bond reference (`rail`, `network`,
 * `proofRef`) but has never verified anything: the distributed ceremony records
 * it verbatim with `bondVerified:false`. The per-rail proof lives in the HOST
 * (bao.markets `CourtBondVerifier`: Liquid testnet dual-Esplora, Bitcoin
 * testnet4 first-party node + mempool.space), and this repository is a protocol
 * library that must stay free of host dependencies (no RPC credentials, no
 * explorer clients, no rail adapters).
 *
 * So the gate is PLUGGABLE: the host supplies a command
 *
 *   BAO_COURT_BOND_CHECK_CMD=<cmd>
 *
 * and the harness invokes it once per juror, appending exactly:
 *
 *   --rail=<rail> --network=<network> --proof=<proofRef>
 *   --bond-sats=<n> --juror-pubkey=<64-hex x-only>
 *
 * The command must exit 0 and print ONE JSON object on stdout:
 *
 *   {"ok":true,"proofRef":"<same proofRef>","sources":["blockstream",…]}
 *
 * or exit non-zero with a typed refusal
 * (`{"ok":false,"code":"BOND_SPENT","detail":"…"}`).
 *
 * FAIL-CLOSED RULES, all decided here (never in the command):
 *   - a juror whose check refuses, times out, prints junk, or attests a
 *     DIFFERENT proofRef than the roster claims is EXCLUDED from the roster
 *     before the DKG starts;
 *   - a `rail:'none'` juror is excluded the same way under `requireBonds`
 *     (`--require-bonds`): claiming no bond is not a bond;
 *   - if exclusions leave fewer jurors than the threshold the ceremony fails
 *     closed with `ROSTER_BELOW_THRESHOLD` and emits no key and no signature.
 *
 * WITH NO COMMAND CONFIGURED THE GATE IS INERT: `bondVerified:false`, nothing
 * enforced, byte-for-byte today's behaviour. That is deliberate — an unmodified
 * environment (and therefore the existing suite) behaves exactly as before.
 */

import { BOND_NETWORKS, BOND_RAILS, formatCourtBondRef, type CourtBondRef } from './bondVerification';

/** Environment variable naming the host command that proves a bond. */
export const BOND_CHECK_ENV = 'BAO_COURT_BOND_CHECK_CMD';

/** Why a juror did not keep its seat. */
export type BondGateRefusal =
  /** The check command refused (`ok:false`) with a typed rail code. */
  | 'BOND_CHECK_REFUSED'
  /** The check command exited non-zero without a parseable refusal. */
  | 'BOND_CHECK_FAILED'
  /** The check command printed something that is not the contract object. */
  | 'BOND_CHECK_MALFORMED'
  /** The check command did not answer inside the harness timeout. */
  | 'BOND_CHECK_TIMEOUT'
  /** The check proved a DIFFERENT proofRef than the roster entry claims. */
  | 'BOND_PROOF_MISMATCH'
  /** Strict run (`--require-bonds`) and the juror claims no bond at all. */
  | 'BOND_NOT_CLAIMED';

/** One juror's bond check invocation. */
export interface BondCheckRequest {
  readonly rail: CourtBondRef['rail'];
  readonly network: CourtBondRef['network'];
  readonly proofRef: string;
  /** Bond the ceremony requires, in satoshis. */
  readonly bondSats: number;
  /** The juror's certificate key (x-only 64-hex), as published to the roster. */
  readonly jurorPubkey: string;
}

/** The command's answer, already parsed and constrained. */
export interface BondCheckVerdict {
  readonly ok: boolean;
  /** Typed rail code on refusal (`BOND_SPENT`, `BOND_UNVERIFIABLE`, …). */
  readonly code: string | null;
  readonly detail: string | null;
  /** The proof the command says it proved (must equal the claim). */
  readonly proofRef: string | null;
  /** Independent sources that agreed, for the artifact. */
  readonly sources: readonly string[];
}

/** A roster entry plus the bond it claims. */
export interface JurorBondClaim {
  readonly idx: number;
  readonly pubkey: string;
  readonly bond: CourtBondRef;
}

/** One juror's gate decision, recorded in the run artifact. */
export interface JurorBondVerdict {
  readonly idx: number;
  readonly pubkey: string;
  readonly bond: CourtBondRef;
  readonly bondRef: string;
  /** True only for a PROVEN bond, and only when enforcement is armed. */
  readonly bondVerified: boolean;
  readonly admitted: boolean;
  /** Typed reason when excluded; null when admitted. */
  readonly refusal: BondGateRefusal | null;
  /** The command's own code (`BOND_SPENT`, …) when it refused. */
  readonly code: string | null;
  readonly detail: string | null;
  readonly sources: readonly string[];
}

/** The whole roster's gate decision. */
export interface RosterBondGate {
  readonly enforced: boolean;
  readonly requireBonds: boolean;
  readonly threshold: number;
  readonly admitted: readonly JurorBondVerdict[];
  readonly excluded: readonly JurorBondVerdict[];
  /** False when the surviving roster cannot meet the threshold. */
  readonly ok: boolean;
  /** `ROSTER_BELOW_THRESHOLD` when the ceremony must not start, else null. */
  readonly classification: 'ROSTER_BELOW_THRESHOLD' | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_PROOF_REF = /^[\x21-\x7e]{1,512}$/;

/**
 * The exact argv the harness appends to `BAO_COURT_BOND_CHECK_CMD`, in a fixed
 * documented order. Every value is validated by the callers below so a value
 * can never be anything but an inert `--flag=value` token.
 */
export function buildBondCheckArgs(request: BondCheckRequest): string[] {
  assertRailAndNetwork(request.rail, request.network);
  const proofRef = request.proofRef;
  if (typeof proofRef !== 'string' || !SAFE_PROOF_REF.test(proofRef)) {
    throw new Error('bondCheck: proofRef must be 1..512 printable ASCII characters with no whitespace');
  }
  if (!Number.isSafeInteger(request.bondSats) || request.bondSats < 0) {
    throw new Error('bondCheck: bondSats must be a non-negative safe integer');
  }
  if (!HEX64.test(request.jurorPubkey)) {
    throw new Error('bondCheck: jurorPubkey must be 64 lowercase hex characters');
  }
  return [
    `--rail=${request.rail}`,
    `--network=${request.network}`,
    `--proof=${proofRef}`,
    `--bond-sats=${request.bondSats}`,
    `--juror-pubkey=${request.jurorPubkey}`,
  ];
}

function assertRailAndNetwork(rail: string, network: string): void {
  if (!(BOND_RAILS as readonly string[]).includes(rail)) {
    throw new Error(`bondCheck: rail must be one of ${BOND_RAILS.join('|')} (got "${rail}")`);
  }
  if (!(BOND_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`bondCheck: network must be one of ${BOND_NETWORKS.join('|')} (got "${network}")`);
  }
}

/**
 * Parse the command's stdout. STRICT: exactly one JSON object carrying
 * `{ok:boolean}`. Anything else is `BOND_CHECK_MALFORMED` — a check that
 * prints a log line before its verdict, or nothing at all, never passes.
 *
 * A refusal (`ok:false`) is accepted in two forms — a typed object, or a
 * non-zero exit with no parsable body (handled by the caller) — but an `ok:true`
 * body is only valid with a `proofRef` string and a non-empty `sources` array:
 * "I proved it" must name what it proved and who agreed.
 */
export function parseBondCheckOutput(stdout: string): BondCheckVerdict {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  const malformed = (detail: string): BondCheckVerdict => ({
    ok: false,
    code: 'BOND_CHECK_MALFORMED',
    detail,
    proofRef: null,
    sources: [],
  });
  if (text === '') return malformed('the bond check printed nothing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return malformed(`the bond check did not print JSON (${text.slice(0, 120)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return malformed('the bond check output is not a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.ok !== 'boolean') return malformed('the bond check output has no boolean `ok`');
  const sources = Array.isArray(body.sources)
    ? body.sources.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 64)
    : [];
  const proofRef = typeof body.proofRef === 'string' && body.proofRef !== '' ? body.proofRef : null;
  const code = typeof body.code === 'string' && body.code !== '' ? body.code : null;
  const detail = typeof body.detail === 'string' && body.detail !== '' ? body.detail : null;
  if (!body.ok) {
    return { ok: false, code: code ?? 'BOND_CHECK_REFUSED', detail, proofRef, sources };
  }
  if (proofRef === null) return malformed('an `ok:true` answer must carry the proven `proofRef`');
  if (sources.length === 0) return malformed('an `ok:true` answer must name the agreeing `sources`');
  return { ok: true, code: null, detail, proofRef, sources };
}

/**
 * Decide the roster: which jurors keep a seat, and whether the survivors can
 * still reach the threshold.
 *
 * `verdicts` is keyed by juror index. A missing entry is a refusal, never a
 * pass (`BOND_CHECK_FAILED`): a juror whose check never ran is not bonded.
 *
 * With `enforced:false` every claim is admitted with `bondVerified:false` and
 * the returned gate is always `ok` — the pre-bond behaviour, unchanged.
 */
export function gateRosterOnBonds(options: {
  readonly jurors: readonly JurorBondClaim[];
  readonly threshold: number;
  readonly enforced: boolean;
  readonly requireBonds: boolean;
  /** Verification results by juror index (absent = not checked / crashed). */
  readonly verdicts?: ReadonlyMap<number, BondCheckVerdict> | Readonly<Record<number, BondCheckVerdict>>;
}): RosterBondGate {
  const { jurors, threshold, enforced, requireBonds } = options;
  const verdictFor = (idx: number): BondCheckVerdict | undefined => {
    const v = options.verdicts;
    if (!v) return undefined;
    if (v instanceof Map) return v.get(idx);
    return (v as Readonly<Record<number, BondCheckVerdict>>)[idx];
  };
  if (!Array.isArray(jurors) || jurors.length === 0) {
    throw new Error('bondCheck: the roster must be a non-empty array');
  }
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > jurors.length) {
    throw new Error(`bondCheck: threshold must be an integer in 1..${jurors.length}`);
  }

  const decisions: JurorBondVerdict[] = jurors.map((juror) => {
    assertRailAndNetwork(juror.bond.rail, juror.bond.network);
    const base = {
      idx: juror.idx,
      pubkey: juror.pubkey,
      bond: juror.bond,
      bondRef: formatCourtBondRef(juror.bond),
    };
    const refuse = (
      refusal: BondGateRefusal,
      verdict: BondCheckVerdict | undefined,
    ): JurorBondVerdict => ({
      ...base,
      bondVerified: false,
      admitted: false,
      refusal,
      code: verdict?.code ?? null,
      detail: verdict?.detail ?? null,
      sources: verdict?.sources ?? [],
    });

    if (!enforced) {
      // Inert gate: the reference is carried and recorded, exactly as before.
      return {
        ...base,
        bondVerified: false,
        admitted: true,
        refusal: null,
        code: null,
        detail: null,
        sources: [],
      };
    }
    if (juror.bond.rail === 'none') {
      // A "none" claim has nothing to prove. Under a strict run that costs the
      // seat ("no bond claimed" is not a bond); without `--require-bonds` the
      // juror keeps it, recorded honestly as unverified — the same disabled
      // placement a half-armed rollout would want.
      if (requireBonds) return refuse('BOND_NOT_CLAIMED', undefined);
      return {
        ...base,
        bondVerified: false,
        admitted: true,
        refusal: null,
        code: null,
        detail: 'no bond claimed (non-strict run: admitted unverified)',
        sources: [],
      };
    }
    const verdict = verdictFor(juror.idx);
    if (!verdict) return refuse('BOND_CHECK_FAILED', undefined);
    if (!verdict.ok) {
      const refusal: BondGateRefusal = verdict.code === 'BOND_CHECK_MALFORMED'
        ? 'BOND_CHECK_MALFORMED'
        : 'BOND_CHECK_REFUSED';
      return refuse(refusal, verdict);
    }
    if (juror.bond.proofRef === null || verdict.proofRef !== juror.bond.proofRef) {
      return refuse('BOND_PROOF_MISMATCH', verdict);
    }
    return {
      ...base,
      bondVerified: true,
      admitted: true,
      refusal: null,
      code: null,
      detail: verdict.detail,
      sources: verdict.sources,
    };
  });

  const admitted = decisions.filter((d) => d.admitted);
  const excluded = decisions.filter((d) => !d.admitted);
  if (!enforced) {
    return {
      enforced: false,
      requireBonds,
      threshold,
      admitted,
      excluded,
      ok: true,
      classification: null,
    };
  }
  const ok = admitted.length >= threshold;
  return {
    enforced: true,
    requireBonds,
    threshold,
    admitted,
    excluded,
    ok,
    classification: ok ? null : 'ROSTER_BELOW_THRESHOLD',
  };
}
