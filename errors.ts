// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Unified error taxonomy for @bao/court (v0.10.1).
 *
 * Every error thrown across the package boundary is a {@link CourtError}.
 * The model has three axes, each holdable on its own:
 *
 * 1. **Class** — how to catch. Legacy classes keep their names and
 *    constructors (compat, v0.10.0 and earlier); new domain classes inherit
 *    the base constructor.
 * 2. **`code`** — what happened, machine-readable. New codes are
 *    SCREAMING_SNAKE (`DKG_STATE`, `ESCROW_LEDGER`, …); the pre-existing
 *    per-class code unions (`CourtSessionValidationCode`, `CourtInboxErrorCode`,
 *    …) keep their historical lowercase values — compat is additive and
 *    existing `err.code` assertions stay green. The full registry lives in
 *    docs/FORMAL_INVARIANTS.md §15.
 * 3. **`invariant`** — which INV-* id the error enforces, when it enforces
 *    one (traceability column in the same doc).
 *
 * Cause-chaining: pass `{ cause }` and the base forwards it to
 * `Error(message, { cause })` (ES2022), so `err.cause` and `util.inspect`
 * chains work everywhere.
 */

/** Shared options for every CourtError constructor. */
export interface CourtErrorOptions {
  /** The underlying error, preserved as `err.cause` (ES2022 chaining). */
  readonly cause?: unknown;
  /** INV-* id from docs/FORMAL_INVARIANTS.md when the error enforces one. */
  readonly invariant?: string;
}

/**
 * Abstract base of the whole taxonomy: every error the package throws.
 * `code` is always present; `invariant` when the check enforces a documented
 * invariant.
 */
export class CourtError extends Error {
  /** Machine-readable failure code (see docs/FORMAL_INVARIANTS.md §15). */
  readonly code: string;
  /** INV-* id this error enforces, when documented. */
  readonly invariant?: string;

  constructor(code: string, message: string, options?: CourtErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (options?.invariant !== undefined) this.invariant = options.invariant;
  }
}

/**
 * Caller-bug argument validation: a malformed argument at the public API —
 * wrong shape, range, or encoding of caller-supplied input. Protocol-state
 * and ledger-integrity failures use the per-domain subclasses instead.
 */
export class CourtArgumentError extends CourtError {
  constructor(code: string, message: string, options?: CourtErrorOptions) {
    super(code, message, options);
  }
}

// ─── Domain classes (new in v0.10.1) ─────────────────────────────────────────
// Each inherits the `(code, message, options?)` base constructor; codes are
// registered in docs/FORMAL_INVARIANTS.md §15.

/** dkg.ts — FROST DKG protocol/state failures (share verification, quorum, refresh). */
export class CourtDkgError extends CourtError {}

/** independentDkg.ts — the independent DKG reimplementation's protocol/state failures. */
export class IndependentDkgError extends CourtError {}

/** independentSigning.ts — independent signing reimplementation protocol/state failures. */
export class IndependentSigningError extends CourtError {}

/** signing.ts — FROST signing session failures (nonce reuse, verification, aggregation). */
export class FrostSigningError extends CourtError {}

/** selection.ts — juror selection state failures (quorum not met). */
export class CourtSelectionError extends CourtError {}

/** escrow.ts — EscrowLedger integrity/state failures (duplicate, wrong-status, unknown deposit). */
export class EscrowLedgerError extends CourtError {}

/** lnSettlement.ts — LnHoldLedger integrity/state failures. */
export class LnHoldLedgerError extends CourtError {}

/** lnRail.ts — Lightning rail failures (missing invoice, injected fault, hold miswiring). */
export class LnRailError extends CourtError {}

/** liquidEscrow.ts — Liquid covenant script failures that are not argument-shape errors. */
export class LiquidEscrowError extends CourtError {}

/** taprootSpend.ts — Taproot script-path failures that are not argument-shape errors. */
export class TaprootSpendError extends CourtError {}

/** crypto.ts / nip44Crypto.ts — cryptographic primitive failures that are not argument-shape errors. */
export class CourtCryptoError extends CourtError {}

/** courtSigner.ts — external-signer protocol failures (invalid NIP-59 seal). */
export class CourtSignerError extends CourtError {}

/** appealCoordinator.ts / appealWatcher.ts — appeal pipeline state and environment failures. */
export class AppealError extends CourtError {
  constructor(message: string, code = 'APPEAL_STATE', options?: CourtErrorOptions) {
    super(code, message, options);
  }
}
