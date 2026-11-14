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
 *   - ONE BOND, ONE SEAT (v0.17.1): within one run a canonical bond identity
 *     (`bondIdentity` = rail + network + case-folded, trimmed `proofRef`) may
 *     admit AT MOST ONE seat. A second juror presenting the same bond is
 *     refused with `BOND_REUSED_ACROSS_SEATS`, because a bond is collateral for
 *     ONE seat — presenting it twice would buy two seats for one coin. The
 *     FIRST claimant in roster order keeps the seat; that order is the box/seat
 *     order the harness drives, so the outcome is deterministic and a run is
 *     reproducible (an arbitrary winner would make artifacts irreproducible).
 *     The dedupe is PER-RUN state — a fresh map inside each
 *     `gateRosterOnBonds` call, never persisted, never module-global — so the
 *     same funded outpoint is legitimately reusable in the NEXT ceremony (the
 *     soak re-uses the same funded bonds every cycle: that must keep working);
 *   - if exclusions leave fewer jurors than the threshold the ceremony fails
 *     closed with `ROSTER_BELOW_THRESHOLD` and emits no key and no signature.
 *
 * The gate also refuses what it cannot read: the checker's stdout is bounded
 * (`BOND_CHECK_MAX_OUTPUT_BYTES`, mirroring the runner's 8 MiB spawn cap) and
 * must be exactly ONE JSON object, and — when the caller passes the request it
 * made (`parseBondCheckOutput(stdout, request)`) — the answer's `proofRef` must
 * be the SAME bond identity that was requested, and any `rail`/`network` it
 * echoes back must match. The roster decision re-checks the identity itself, so
 * a mismatch is refused by the gate even if a caller forgets to compare.
 *
 * WITH NO COMMAND CONFIGURED THE GATE IS INERT: `bondVerified:false`, nothing
 * enforced, byte-for-byte today's behaviour. That is deliberate — an unmodified
 * environment (and therefore the existing suite) behaves exactly as before.
 */

import { BOND_NETWORKS, BOND_RAILS, formatCourtBondRef, type CourtBondRef } from './bondVerification';

/** Environment variable naming the host command that proves a bond. */
export const BOND_CHECK_ENV = 'BAO_COURT_BOND_CHECK_CMD';

/**
 * Hard ceiling on the checker's stdout, in bytes. It mirrors the runner's
 * `spawnSync({maxBuffer: 8 MiB})` so the protocol refuses — with a typed
 * `BOND_CHECK_MALFORMED` — what the harness would otherwise truncate or kill.
 * A bond check answers with ONE small JSON object; anything near this bound is
 * not an answer.
 */
export const BOND_CHECK_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** UTF-8 byte length without `Buffer` (this module is browser-safe). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair: 4 UTF-8 bytes for two UTF-16 units
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Canonical form of a `proofRef` for IDENTITY comparisons: surrounding
 * whitespace is dropped and ASCII case is folded. Both are safe because a
 * `proofRef` is an *identifier*, never a checksum or a signature: outpoint
 * txids, payment hashes and token ids are hex (case-insensitive), and bech32 is
 * case-insensitive by specification. `"ABC…:0 "` and `"abc…:0"` are therefore
 * the SAME bond, which is exactly what a duplicate-seat check must assume —
 * anything stricter lets a seat be bought twice by re-typing the txid in caps.
 */
export function normaliseBondProofRef(proofRef: string): string {
  return proofRef.trim().toLowerCase();
}

/**
 * The canonical identity of a bond — `rail/network:<case-folded proofRef>`.
 * Two claims with the same identity are the same collateral: the gate seats at
 * most one of them per run (`BOND_REUSED_ACROSS_SEATS`).
 */
export function bondIdentity(bond: CourtBondRef): string {
  const proof = bond.proofRef === null ? '' : normaliseBondProofRef(bond.proofRef);
  return `${bond.rail}/${bond.network}:${proof}`;
}

/** What the caller asked the checker to prove (for the answer's cross-check). */
export interface BondCheckExpectation {
  readonly rail: CourtBondRef['rail'];
  readonly network: CourtBondRef['network'];
  readonly proofRef: string;
}

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
  | 'BOND_NOT_CLAIMED'
  /**
   * This run already seated a DIFFERENT juror on the same bond identity. One
   * bond is collateral for one seat; the first claimant keeps it.
   */
  | 'BOND_REUSED_ACROSS_SEATS';

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
  /** Canonical bond identity (`bondIdentity`) — the duplicate-seat key. */
  readonly bondIdentity: string;
  /** True only for a PROVEN bond, and only when enforcement is armed. */
  readonly bondVerified: boolean;
  readonly admitted: boolean;
  /** Typed reason when excluded; null when admitted. */
  readonly refusal: BondGateRefusal | null;
  /** The command's own code (`BOND_SPENT`, …) when it refused. */
  readonly code: string | null;
  readonly detail: string | null;
  readonly sources: readonly string[];
  /**
   * For `BOND_REUSED_ACROSS_SEATS`: the index of the seat that kept this bond
   * (the first claimant in roster order). Null otherwise.
   */
  readonly duplicateOf: number | null;
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
 *
 * BOUNDED: more than `BOND_CHECK_MAX_OUTPUT_BYTES` of stdout is refused before
 * parsing (the gate never reads an unbounded answer), and the text must be one
 * JSON object and nothing else — the first/last non-space characters have to be
 * `{`/`}` on top of `JSON.parse`'s own trailing-content rejection.
 *
 * WHEN THE CALLER PASSES THE REQUEST (`expected`), the answer must be for THAT
 * request: the proven `proofRef` is compared on its canonical identity
 * (`bondIdentity`), so case/whitespace differences do not mask a different
 * outpoint, and any `rail`/`network` the command echoes back must agree
 * (`BOND_RAIL_MISMATCH`). The gate re-checks the identity in the roster
 * decision too — the refusal must not depend on the caller remembering.
 */
export function parseBondCheckOutput(
  stdout: string,
  expected?: BondCheckExpectation,
): BondCheckVerdict {
  const raw = typeof stdout === 'string' ? stdout : '';
  const text = raw.trim();
  const malformed = (detail: string): BondCheckVerdict => ({
    ok: false,
    code: 'BOND_CHECK_MALFORMED',
    detail,
    proofRef: null,
    sources: [],
  });
  const byteLength = utf8ByteLength(raw);
  if (byteLength > BOND_CHECK_MAX_OUTPUT_BYTES) {
    return malformed(
      `the bond check printed ${byteLength} bytes, over the ${BOND_CHECK_MAX_OUTPUT_BYTES}-byte ceiling`,
    );
  }
  if (text === '') return malformed('the bond check printed nothing');
  if (text[0] !== '{' || text[text.length - 1] !== '}') {
    return malformed(`the bond check did not print ONE JSON object (${text.slice(0, 120)})`);
  }
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
  if (!SAFE_PROOF_REF.test(proofRef)) {
    return malformed('an `ok:true` answer must carry a 1..512 printable-ASCII `proofRef` with no whitespace');
  }
  if (sources.length === 0) return malformed('an `ok:true` answer must name the agreeing `sources`');
  if (expected) {
    const proved = bondIdentity({ rail: expected.rail, network: expected.network, proofRef });
    const requested = bondIdentity({
      rail: expected.rail,
      network: expected.network,
      proofRef: expected.proofRef,
    });
    if (proved !== requested) {
      return {
        ok: false,
        code: 'BOND_PROOF_MISMATCH',
        detail: `the bond check proved ${proved} but ${requested} was requested`,
        proofRef,
        sources,
      };
    }
    const echoedRail = typeof body.rail === 'string' ? body.rail : null;
    const echoedNetwork = typeof body.network === 'string' ? body.network : null;
    if ((echoedRail !== null && echoedRail !== expected.rail)
      || (echoedNetwork !== null && echoedNetwork !== expected.network)) {
      return {
        ok: false,
        code: 'BOND_RAIL_MISMATCH',
        detail: `the bond check answered for ${echoedRail ?? expected.rail}/${echoedNetwork ?? expected.network}`
          + ` but ${expected.rail}/${expected.network} was requested`,
        proofRef,
        sources,
      };
    }
  }
  return { ok: true, code: null, detail, proofRef, sources };
}

/**
 * Decide the roster: which jurors keep a seat, and whether the survivors can
 * still reach the threshold.
 *
 * `verdicts` is keyed by juror index. A missing entry is a refusal, never a
 * pass (`BOND_CHECK_FAILED`): a juror whose check never ran is not bonded.
 *
 * ONE BOND, ONE SEAT: within THIS call a canonical bond identity
 * (`bondIdentity`) is admitted at most once. `jurors` is walked in array order
 * — the harness's box/seat order — and the FIRST claimant that proves the bond
 * keeps the seat; a later claimant of the same identity is refused with
 * `BOND_REUSED_ACROSS_SEATS` (`duplicateOf` = the seat that kept it). An
 * identity is consumed only by a PROVEN admission, so a juror whose check
 * refused never reserves the bond for anyone. The map lives inside this call:
 * nothing is persisted and nothing is module-global, so the same bond is
 * legitimately reusable by the NEXT ceremony.
 *
 * With `enforced:false` every claim is admitted with `bondVerified:false` and
 * the returned gate is always `ok` — the pre-bond behaviour, unchanged. No
 * enforcement means no dedupe: an inert gate decides nothing.
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

  /** Per-run seat ledger: canonical bond identity → index of the seat holding it. */
  const seatsByBond = new Map<string, number>();

  const decisions: JurorBondVerdict[] = jurors.map((juror) => {
    assertRailAndNetwork(juror.bond.rail, juror.bond.network);
    const base = {
      idx: juror.idx,
      pubkey: juror.pubkey,
      bond: juror.bond,
      bondRef: formatCourtBondRef(juror.bond),
      bondIdentity: bondIdentity(juror.bond),
    };
    const refuse = (
      refusal: BondGateRefusal,
      verdict: BondCheckVerdict | undefined,
      override?: { detail?: string; duplicateOf?: number },
    ): JurorBondVerdict => ({
      ...base,
      bondVerified: false,
      admitted: false,
      refusal,
      code: verdict?.code ?? null,
      detail: override?.detail ?? verdict?.detail ?? null,
      sources: verdict?.sources ?? [],
      duplicateOf: override?.duplicateOf ?? null,
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
        duplicateOf: null,
      };
    }
    if (juror.bond.rail === 'none') {
      // A "none" claim has nothing to prove. Under a strict run that costs the
      // seat ("no bond claimed" is not a bond); without `--require-bonds` the
      // juror keeps it, recorded honestly as unverified — the same disabled
      // placement a half-armed rollout would want. No bond, no identity: it can
      // neither hold nor consume a seat's collateral.
      if (requireBonds) return refuse('BOND_NOT_CLAIMED', undefined);
      return {
        ...base,
        bondVerified: false,
        admitted: true,
        refusal: null,
        code: null,
        detail: 'no bond claimed (non-strict run: admitted unverified)',
        sources: [],
        duplicateOf: null,
      };
    }
    const verdict = verdictFor(juror.idx);
    if (!verdict) return refuse('BOND_CHECK_FAILED', undefined);
    if (!verdict.ok) {
      const refusal: BondGateRefusal = verdict.code === 'BOND_CHECK_MALFORMED'
        ? 'BOND_CHECK_MALFORMED'
        : verdict.code === 'BOND_PROOF_MISMATCH'
          ? 'BOND_PROOF_MISMATCH'
          : 'BOND_CHECK_REFUSED';
      return refuse(refusal, verdict);
    }
    // The gate refuses a mismatch ITSELF — on the canonical identity, so a
    // checker that echoes the outpoint in upper case is the same bond while a
    // genuinely different outpoint is not. Never rely on the caller comparing.
    if (juror.bond.proofRef === null
      || bondIdentity({ ...juror.bond, proofRef: verdict.proofRef ?? '' }) !== base.bondIdentity) {
      return refuse('BOND_PROOF_MISMATCH', verdict, {
        detail: verdict.proofRef === null
          ? 'the check proved nothing it can name'
          : `the check proved ${verdict.proofRef} but ${juror.bond.proofRef} was requested`,
      });
    }
    // ONE BOND, ONE SEAT. Roster order is box/seat order: the first claimant
    // keeps the seat (deterministic, therefore reproducible), and every later
    // claimant of the same collateral is refused.
    const holder = seatsByBond.get(base.bondIdentity);
    if (holder !== undefined) {
      return refuse('BOND_REUSED_ACROSS_SEATS', verdict, {
        detail: `${base.bondIdentity} already backs seat ${holder} in this run`
          + ' (one bond is collateral for one seat; the first claimant keeps it)',
        duplicateOf: holder,
      });
    }
    seatsByBond.set(base.bondIdentity, juror.idx);
    return {
      ...base,
      bondVerified: true,
      admitted: true,
      refusal: null,
      code: null,
      detail: verdict.detail,
      sources: verdict.sources,
      duplicateOf: null,
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
