// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Hand-crafted, deterministic mutant catalogue for the BAO Court spec.
 *
 * Every entry is ONE semantic mutation (a single `find` → `replace` edit in
 * one source file) with a stable id. Each mutation is a bug class the spec
 * claims to exclude; if no detector notices it, the spec is blind to that
 * class (the facility question behind `docs/MUTATION_TESTING.md`).
 *
 * Contract for entries:
 *   id      stable identifier (M01, M02, …) — never reused, never renumbered
 *   cls     bug class (one of CLASSES below); drives the per-class score
 *   file    repo-relative source path (exactly one file)
 *   find    exact substring in that file, occurring EXACTLY ONCE in the
 *           pristine source (the runner refuses to apply an ambiguous mutant)
 *   replace replacement text (may be '' to delete a guard)
 *   intent  what the mutation breaks, in protocol terms
 *   machine which phase machine the model explorer must probe ('confirmation'
 *           | 'vote' | 'signing' | null when the mutant touches no modelled
 *           machine — model checking is structurally blind there)
 *   deep    true → ALSO explore the expensive confirmation instance (q=3)
 *
 * Determinism: the catalogue is ordered by id and contains no randomness,
 * no environment reads, and no generated values.
 */

export const CLASSES = {
  'deadline-off-by-one': 'deadline boundary (exactly-at vs deadline-1)',
  'tie-break-reversal': 'deterministic tie-break order (UTF-8 bytes vs UTF-16 units)',
  'quorum-dropped': 'confirmation quorum check dropped',
  'threshold-weakened': 'threshold/finality minimum weakened (>= → >)',
  'ledger-barrier-removed': 'ledger barrier (assertValid*) skipped',
  'duplicate-idx': 'duplicate index / duplicate record accepted',
  'monotonic-clock-removed': 'monotonic-clock ledger check removed',
  'clamp-boundary': 'clamp / boundary comparison flipped (>= vs >)',
  'merkle-domain-separation': 'Merkle leaf/node domain tag swapped',
  'signer-set-check-dropped': 'signer-set length / freeze check dropped',
  'cap-off-by-one': 'cap boundary off-by-one (attempt/round/batch cap)',
  'clawback-dedup-removed': 'clawback flag dedup removed',
  'phase-guard-loosened': 'terminal-phase guard loosened (post-terminal event accepted)',
  'abort-precedence': 'abort precedence inverted (abort no longer pre-terminal)',
  'encoding-length-prefix': 'CanonicalWriter length prefix / endianness broken',
  'hex-case': 'uppercase hex accepted where canonical lowercase is required',
  'empty-pin-acceptance': 'empty-string pin accepted (F-2 regression)',
  'proof-bounds': 'batch proof/duplicate bounds loosened',
};

/** @typedef {keyof typeof CLASSES} MutantClass */

/** The catalogue. @type {ReadonlyArray<{id:string,cls:MutantClass,file:string,find:string,replace:string,intent:string,machine:null|'confirmation'|'vote'|'signing',deep?:boolean}>} */
export const MUTANTS = [
  // ── deadline off-by-one (exactly-at vs deadline-1) ───────────────────────
  {
    id: 'M01',
    cls: 'deadline-off-by-one',
    file: 'courtCeremonyCore.ts',
    find: '  assertNow(now, ErrorCtor);\n  if (now >= deadline) {\n    throw new ErrorCtor(message);\n  }',
    replace: '  assertNow(now, ErrorCtor);\n  if (now > deadline) {\n    throw new ErrorCtor(message);\n  }',
    intent: 'accepts an event arriving EXACTLY at the deadline (should be strictly-before) — every machine shares this guard',
    machine: null,
  },
  {
    id: 'M02',
    cls: 'deadline-off-by-one',
    file: 'confirmationMachineHandlers.ts',
    find: '  if (deadline === undefined || event.now < deadline) {',
    replace: '  if (deadline === undefined || event.now <= deadline) {',
    intent: 'a tick at exactly the deadline no longer expires the phase (expiry slips one tick)',
    machine: 'confirmation',
  },
  {
    id: 'M03',
    cls: 'deadline-off-by-one',
    file: 'confirmationMachineHandlers.ts',
    find: "  if (event.now < state.confirmDeadline) {\n    throw new CourtConfirmationTransitionError(\n      'cannot close confirmations before the confirm deadline',",
    replace: "  if (event.now <= state.confirmDeadline) {\n    throw new CourtConfirmationTransitionError(\n      'cannot close confirmations before the confirm deadline',",
    intent: 'the legal at-deadline close is refused (boundary moved one tick the other way)',
    machine: 'confirmation',
  },
  {
    id: 'M04',
    cls: 'deadline-off-by-one',
    file: 'courtVoteMachine.ts',
    find: '    || event.now < state.revealDeadline\n  ) {',
    replace: '    || event.now <= state.revealDeadline\n  ) {',
    intent: 'the vote ceremony does not expire at exactly the reveal deadline',
    machine: 'vote',
  },

  // ── tie-break reversal (UTF-8 vs UTF-16) ─────────────────────────────────
  {
    id: 'M05',
    cls: 'tie-break-reversal',
    file: 'courtVoteMachine.ts',
    find: '  const leftBytes = textEncoder.encode(left);\n  const rightBytes = textEncoder.encode(right);\n  const length = Math.min(leftBytes.length, rightBytes.length);\n  for (let i = 0; i < length; i += 1) {\n    const difference = leftBytes[i] - rightBytes[i];\n    if (difference !== 0) return difference;\n  }\n  return leftBytes.length - rightBytes.length;',
    replace: '  return left < right ? -1 : left > right ? 1 : 0;',
    intent: 'UTF-16 code-unit order replaces UTF-8 byte (code point) order: astral vs BMP outcomes sort differently',
    machine: 'vote',
  },
  {
    id: 'M06',
    cls: 'tie-break-reversal',
    file: 'confirmationMachineHandlers.ts',
    find: '      (eventIds.length === winnerCount && compareOutcomeUtf8(outcome, winner) < 0)',
    replace: '      (eventIds.length === winnerCount && compareOutcomeUtf8(outcome, winner) > 0)',
    intent: 'ladder-round ties resolve to the larger outcome instead of the canonical smaller one',
    machine: 'confirmation',
  },
  {
    id: 'M07',
    cls: 'tie-break-reversal',
    file: 'selection.ts',
    find: '        || (a.juror.nostrPubkey < b.juror.nostrPubkey ? -1 : a.juror.nostrPubkey > b.juror.nostrPubkey ? 1 : 0),',
    replace: '        || (a.juror.nostrPubkey > b.juror.nostrPubkey ? -1 : a.juror.nostrPubkey < b.juror.nostrPubkey ? 1 : 0),',
    intent: 'exact-priority ties rank pubkeys descending — the draw stops being reproducible across implementations',
    machine: null,
  },

  // ── quorum check dropped / off-by-one in close_confirmations ─────────────
  {
    id: 'M08',
    cls: 'quorum-dropped',
    file: 'confirmationMachineHandlers.ts',
    find: '  if (state.confirmations.length < state.confirmQuorum) {\n    throw new CourtConfirmationTransitionError(\n      `confirm quorum not met: ${state.confirmations.length}/${state.confirmQuorum}`,\n    );\n  }',
    replace: '',
    intent: 'close_confirmations proceeds with fewer confirmations than the quorum (silent under-quorum case)',
    machine: 'confirmation',
    deep: true,
  },
  {
    id: 'M09',
    cls: 'quorum-dropped',
    file: 'confirmationMachineHandlers.ts',
    find: '  if (state.confirmations.length < state.confirmQuorum) {',
    replace: '  if (state.confirmations.length <= state.confirmQuorum) {',
    intent: 'quorum becomes quorum+1 (a satisfied quorum is refused) — quorum boundary off-by-one',
    machine: 'confirmation',
    deep: true,
  },

  // ── threshold weakened (>= → >) ──────────────────────────────────────────
  {
    id: 'M10',
    cls: 'threshold-weakened',
    file: 'courtSigningMachine.ts',
    find: '  if (state.commitments.length < state.threshold) {',
    replace: '  if (state.commitments.length < state.threshold - 1) {',
    intent: 'the commitment set freezes with t-1 signers — the distinct-signer threshold is no longer reached',
    machine: 'signing',
  },
  {
    id: 'M11',
    cls: 'threshold-weakened',
    file: 'courtSigningMachine.ts',
    find: '  if (state.partials.length < state.threshold) {',
    replace: '  if (state.partials.length < state.threshold - 1) {',
    intent: 'aggregation accepts t-1 partial signatures (t-1-of-n "threshold" aggregate)',
    machine: 'signing',
  },
  {
    id: 'M12',
    cls: 'threshold-weakened',
    file: 'validator.ts',
    find: '  if (context.minThreshold !== undefined && fields.threshold < context.minThreshold) {',
    replace: '  if (context.minThreshold !== undefined && fields.threshold < context.minThreshold - 1) {',
    intent: 'finality policy admits an attestation whose threshold is one below the pinned minimum',
    machine: null,
  },
  {
    id: 'M13',
    cls: 'threshold-weakened',
    file: 'validator.ts',
    find: '  if (context.minTier !== undefined && fields.tier < context.minTier) {',
    replace: '  if (context.minTier !== undefined && fields.tier < context.minTier - 1) {',
    intent: 'finality policy admits a tier one below the pinned minimum',
    machine: null,
  },

  // ── ledger barrier removal (skip assertValid*) ───────────────────────────
  {
    id: 'M14',
    cls: 'ledger-barrier-removed',
    file: 'confirmationMachineHandlers.ts',
    find: '  assertValidMassVoteLedger(state);\n  assertValidConfirmationLedger(state);\n',
    replace: '  assertValidConfirmationLedger(state);\n',
    intent: 'resolve_round trusts a hand-restored mass-vote ledger (ballot closure, roster, uniqueness unchecked)',
    machine: 'confirmation',
  },
  {
    id: 'M15',
    cls: 'ledger-barrier-removed',
    file: 'confirmationMachineHandlers.ts',
    find: '  assertValidConfirmationLedger(state);\n  // Outcome-history barrier (finding F-3): the flip-flop rule',
    replace: '  // Outcome-history barrier (finding F-3): the flip-flop rule',
    intent: 'resolve_round takes clawback indices from an unverified confirmation ledger',
    machine: 'confirmation',
  },
  {
    id: 'M16',
    cls: 'ledger-barrier-removed',
    file: 'confirmationMachineHandlers.ts',
    find: '  // Outcome-history barrier (finding F-3): the restored history must\n  // re-verify (consecutive rounds, ballot closure, well-formed winners)\n  // before the machine reaches `final` on top of it.\n  assertValidOutcomeHistory(state);',
    replace: '  // Outcome-history barrier (finding F-3): the restored history must\n  // re-verify (consecutive rounds, ballot closure, well-formed winners)\n  // before the machine reaches `final` on top of it.',
    intent: 'finalize mints a verdict on top of an unverified (forged) outcome history',
    machine: 'confirmation',
  },
  {
    id: 'M17',
    cls: 'ledger-barrier-removed',
    file: 'confirmationMachineHandlers.ts',
    find: "  assertValidMassVoteLedger(state);\n  return freezeState({ ...state, phase: 'ladder_vote_closed' });",
    replace: "  return freezeState({ ...state, phase: 'ladder_vote_closed' });",
    intent: 'close_ladder_round accepts a tampered vote ledger',
    machine: 'confirmation',
  },

  // ── duplicate index/record acceptance ────────────────────────────────────
  {
    id: 'M18',
    cls: 'duplicate-idx',
    file: 'confirmationMachineHandlers.ts',
    find: '  const existing = state.confirmations.find((c) => c.idx === event.idx);\n  if (existing) {\n    if (existing.confirmHash === event.confirmHash && existing.eventId === event.eventId) {\n      return freezeState(state);\n    }\n    throw new CourtConfirmationTransitionError(\n      `participant ${event.idx} published a conflicting confirmation`,\n    );\n  }',
    replace: '  const existing = state.confirmations.find((c) => c.idx === event.idx);\n  if (existing && existing.confirmHash === event.confirmHash && existing.eventId === event.eventId) {\n    return freezeState(state);\n  }',
    intent: 'a juror can publish two different confirmations (one seat, two endorsements)',
    machine: 'confirmation',
  },
  {
    id: 'M19',
    cls: 'duplicate-idx',
    file: 'courtVoteMachine.ts',
    find: '  const existing = state.reveals.find((r) => r.idx === event.idx);',
    replace: '  const existing = state.reveals.find((r) => false);',
    intent: 'one voter reveals twice — the reveal ledger can inflate a tally',
    machine: 'vote',
  },
  {
    id: 'M20',
    cls: 'duplicate-idx',
    file: 'confirmationMachineHandlers.ts',
    find: '  const existing = state.ladder.votes.find((v) => v.idx === event.idx);',
    replace: '  const existing = state.ladder.votes.find((v) => false);',
    intent: 'one round-panel seat mass-votes repeatedly — repeated votes count in the tally',
    machine: 'confirmation',
  },

  // ── monotonic-clock check removal ────────────────────────────────────────
  {
    id: 'M21',
    cls: 'monotonic-clock-removed',
    file: 'courtConfirmationMachine.ts',
    find: "    if (event.now < state.latestTimestamp) {\n      throw new CourtConfirmationTransitionError(\n        'now must not precede a previously observed timestamp',\n      );\n    }",
    replace: '',
    intent: 'clock rollback accepted — a restored snapshot can re-admit events a later timestamp already excluded',
    machine: 'confirmation',
  },
  {
    id: 'M22',
    cls: 'monotonic-clock-removed',
    file: 'courtVoteMachine.ts',
    find: "    if (event.now < state.latestTimestamp) {\n      throw new CourtVoteTransitionError('now must not precede a previously observed timestamp');\n    }",
    replace: '',
    intent: 'clock rollback accepted in the vote machine',
    machine: 'vote',
  },
  {
    id: 'M23',
    cls: 'monotonic-clock-removed',
    file: 'courtSigningMachine.ts',
    find: "    if (event.now < (state.latestTimestamp ?? 0)) {\n      throw new CourtSigningTransitionError('now must not precede a previously observed timestamp');\n    }",
    replace: '',
    intent: 'clock rollback accepted in the signing machine',
    machine: 'signing',
  },

  // ── clamp / boundary flips ───────────────────────────────────────────────
  {
    id: 'M24',
    cls: 'clamp-boundary',
    file: 'selection.ts',
    find: '  let r = random;\n  if (r <= 0) r = Number.MIN_VALUE;\n  if (r >= 1) r = 1 - Number.EPSILON;\n  return -Math.log(r) / Math.sqrt(Math.max(1, stakeSats));',
    replace: '  let r = random;\n  if (r <= 0) r = Number.MIN_VALUE;\n  if (r > 1) r = 1 - Number.EPSILON;\n  return -Math.log(r) / Math.sqrt(Math.max(1, stakeSats));',
    intent: 'r = 1 escapes the clamp → priority 0 → that juror deterministically wins every draw',
    machine: null,
  },
  {
    id: 'M25',
    cls: 'clamp-boundary',
    file: 'selection.ts',
    find: '  let r = random;\n  if (r <= 0) r = Number.MIN_VALUE;\n  if (r >= 1) r = 1 - Number.EPSILON;\n  return -Math.log(r) / weight;',
    replace: '  let r = random;\n  if (r <= 0) r = Number.MIN_VALUE;\n  if (r > 1) r = 1 - Number.EPSILON;\n  return -Math.log(r) / weight;',
    intent: 'same clamp flip in weighted mode — weight is ignored for the r = 1 boundary juror',
    machine: null,
  },
  {
    id: 'M26',
    cls: 'clamp-boundary',
    file: 'selection.ts',
    find: '    if (j.stakeCapacitySats < params.minStakeSats) return false;',
    replace: '    if (j.stakeCapacitySats <= params.minStakeSats) return false;',
    intent: 'eligibility clamp boundary: a juror exactly at the minimum stake is excluded',
    machine: null,
  },

  // ── Merkle domain separation + RFC-6962 split ────────────────────────────
  {
    id: 'M27',
    cls: 'merkle-domain-separation',
    file: 'batchAttestation.ts',
    find: '  writer.u8(0x00);\n  writer.hex(verdictHash);',
    replace: '  writer.u8(0x01);\n  writer.hex(verdictHash);',
    intent: 'leaf preimage reuses the interior-node tag (0x01) — the domain-separation prefix no longer distinguishes levels',
    machine: null,
  },
  {
    id: 'M28',
    cls: 'merkle-domain-separation',
    file: 'batchAttestation.ts',
    find: '  writer.u8(0x01);\n  writer.hex(left);',
    replace: '  writer.u8(0x00);\n  writer.hex(left);',
    intent: 'interior-node preimage reuses the leaf tag (0x00)',
    machine: null,
  },
  {
    id: 'M29',
    cls: 'clamp-boundary',
    file: 'batchAttestation.ts',
    find: '  while (k * 2 <= n - 1) k *= 2;',
    replace: '  while (k * 2 < n - 1) k *= 2;',
    intent: 'RFC-6962 split boundary off-by-one (n = 2^m + 1 and friends) — roots diverge from every other implementation',
    machine: null,
  },

  // ── signer-set length / freeze check dropped ─────────────────────────────
  {
    id: 'M30',
    cls: 'signer-set-check-dropped',
    file: 'validator.ts',
    find: '    if (context.signerSet.length !== fields.threshold) {\n      return { error: { valid: false, pubkey, error: `Signer set size ${context.signerSet.length} does not match threshold ${fields.threshold}` } };\n    }',
    replace: '',
    intent: 'a signer set of any size paired with any declared threshold validates (signerSet root still matches its own set)',
    machine: null,
  },
  {
    id: 'M31',
    cls: 'signer-set-check-dropped',
    file: 'courtSigningMachine.ts',
    find: '      state.finalizedSignerSet.length !== expected.length ||',
    replace: '      false ||',
    intent: "a restored signing state's frozen signer set is no longer re-verified against the stored commitments (A-1)",
    machine: 'signing',
  },

  // ── cap off-by-one (round / batch) ───────────────────────────────────────
  {
    id: 'M32',
    cls: 'cap-off-by-one',
    file: 'confirmationMachineHandlers.ts',
    find: '  if (event.round > state.maxLadderRounds) {',
    replace: '  if (event.round >= state.maxLadderRounds) {',
    intent: 'the last permitted ladder round is refused (cap off-by-one)',
    machine: 'confirmation',
  },
  {
    id: 'M33',
    cls: 'cap-off-by-one',
    file: 'confirmationMachineHandlers.ts',
    find: '  if (state.ladderRound >= state.maxLadderRounds) {',
    replace: '  if (state.ladderRound > state.maxLadderRounds) {',
    intent: 'escalate re-opens a round past the cap — the ladder becomes unbounded',
    machine: 'confirmation',
  },
  {
    id: 'M34',
    cls: 'cap-off-by-one',
    file: 'confirmationMachineHandlers.ts',
    find: '  const isFinalRound = round >= state.maxLadderRounds;',
    replace: '  const isFinalRound = round > state.maxLadderRounds;',
    intent: 'a resolved final round parks in round_resolved instead of settling (host must escalate past the cap)',
    machine: 'confirmation',
  },
  {
    id: 'M35',
    cls: 'cap-off-by-one',
    file: 'batchAttestation.ts',
    find: '  if (verdictHashes.length > MAX_BATCH_VERDICTS) {',
    replace: '  if (verdictHashes.length >= MAX_BATCH_VERDICTS) {',
    intent: 'batch cap off-by-one: exactly MAX_BATCH_VERDICTS is refused',
    machine: null,
  },

  // ── clawback dedup removal ───────────────────────────────────────────────
  {
    id: 'M36',
    cls: 'clawback-dedup-removed',
    file: 'confirmationMachineHandlers.ts',
    find: '    const flags = state.confirmations\n      .filter((c) => !alreadyFlagged.has(c.idx))',
    replace: '    const flags = state.confirmations\n      .filter(() => true)',
    intent: 'overturned_confirmation flags duplicate per juror across rounds (fee clawback queued twice)',
    machine: 'confirmation',
  },
  {
    id: 'M37',
    cls: 'clawback-dedup-removed',
    file: 'confirmationMachineHandlers.ts',
    find: '    const flipFlags = previous.winnerIndices\n      .filter((idx) => !alreadyFlipped.has(idx))',
    replace: '    const flipFlags = previous.winnerIndices\n      .filter(() => true)',
    intent: 'round_flip flags duplicate per voter (idempotence of the flip-flop rule broken)',
    machine: 'confirmation',
  },
  {
    id: 'M38',
    cls: 'clawback-dedup-removed',
    file: 'confirmationMachineHandlers.ts',
    find: '    state.clawbackFlags.some((f) => f.idx === event.idx && f.reason === event.reason)',
    replace: '    state.clawbackFlags.some(() => false)',
    intent: 'operator flag_clawback is no longer idempotent — repeated flags accumulate',
    machine: 'confirmation',
  },

  // ── phase-guard loosening (terminal-phase event accepted) ────────────────
  {
    id: 'M39',
    cls: 'phase-guard-loosened',
    file: 'courtConfirmationMachine.ts',
    find: '  if (TERMINAL_PHASES.has(state.phase)) {\n    throw new CourtConfirmationTransitionError(`cannot process ${event.type} after ${state.phase}`);\n  }',
    replace: '',
    intent: 'the reducer-wide terminal guard is gone: unguarded handlers (record_fee) mutate a settled case',
    machine: 'confirmation',
  },
  {
    id: 'M40',
    cls: 'phase-guard-loosened',
    file: 'courtVoteMachine.ts',
    find: '  if (TERMINAL_PHASES.has(state.phase)) {\n    throw new CourtVoteTransitionError(`cannot process ${event.type} after ${state.phase}`);\n  }',
    replace: '',
    intent: 'same guard removal in the vote machine',
    note: 'EQUIVALENT on v0.10.2+: every vote-machine handler re-checks its own phase, so deleting the reducer-wide terminal guard changes only the error message. Kept because ids are permanent and it goes live again if a handler drops its own phase check; its pass-1 "capture" was the simulateCourt 5 s wall-clock budget failing under load, not a behavioural assertion.',
    machine: 'vote',
  },
  {
    id: 'M41',
    cls: 'phase-guard-loosened',
    file: 'confirmationMachineHandlers.ts',
    find: '  if (TERMINAL_PHASES.has(state.phase)) {\n    throw new CourtConfirmationTransitionError(`cannot abort confirmation from ${state.phase}`);\n  }',
    replace: '',
    intent: 'abort from a terminal phase overwrites a settled verdict with an aborted failure',
    machine: 'confirmation',
  },

  // ── abort precedence ─────────────────────────────────────────────────────
  {
    id: 'M42',
    cls: 'abort-precedence',
    file: 'courtConfirmationMachine.ts',
    find: "  switch (event.type) {\n    case 'tick': return onTick(state, event);\n    case 'abort': return onAbort(state, event);\n    default: break;\n  }",
    replace: "  switch (event.type) {\n    case 'tick': return onTick(state, event);\n    default: break;\n  }",
    intent: 'abort is no longer dispatched before the terminal guard: its precedence over the terminal check is inverted',
    machine: 'confirmation',
  },
  {
    id: 'M43',
    cls: 'abort-precedence',
    file: 'courtVoteMachine.ts',
    find: "  switch (event.type) {\n    case 'tick': return onTick(state, event);\n    case 'abort': return onAbort(state, event);\n    default: break;\n  }",
    replace: "  switch (event.type) {\n    case 'tick': return onTick(state, event);\n    default: break;\n  }",
    intent: 'same precedence inversion in the vote machine',
    machine: 'vote',
  },

  // ── canonical encoding (length prefix / endianness) ──────────────────────
  {
    id: 'M44',
    cls: 'encoding-length-prefix',
    file: 'courtSession.ts',
    find: '  bytes(value: Uint8Array): void {\n    this.u32(value.length);',
    replace: '  bytes(value: Uint8Array): void {',
    intent: 'CanonicalWriter loses its length prefix — adjacent variable-length fields become re-interpretable (delimiter ambiguity)',
    machine: null,
  },
  {
    id: 'M45',
    cls: 'encoding-length-prefix',
    file: 'courtSession.ts',
    find: '    this.view.setUint32(this.len, value, false);\n    this.len += 4;',
    replace: '    this.view.setUint32(this.len, value, true);\n    this.len += 4;',
    intent: 'u32 encoding becomes little-endian — every hash domain diverges from the canonical big-endian spec',
    machine: null,
  },

  // ── uppercase hex acceptance ─────────────────────────────────────────────
  {
    id: 'M46',
    cls: 'hex-case',
    file: 'courtCeremonyCore.ts',
    find: 'export const HEX_32 = /^[0-9a-f]{64}$/;',
    replace: 'export const HEX_32 = /^[0-9a-fA-F]{64}$/;',
    intent: 'uppercase hex accepted as canonical — two spellings of one value (hash/compare/equality divergence)',
    machine: null,
  },
  {
    id: 'M47',
    cls: 'hex-case',
    file: 'courtSession.ts',
    find: 'const HEX_32 = /^[0-9a-f]{64}$/;',
    replace: 'const HEX_32 = /^[0-9a-fA-F]{64}$/;',
    intent: 'same uppercase acceptance in the session encoder',
    machine: null,
  },

  // ── empty-string pin acceptance (F-2) ────────────────────────────────────
  {
    id: 'M48',
    cls: 'empty-pin-acceptance',
    file: 'validator.ts',
    find: "    : (expected ?? {});\n  // F-2: a present-but-empty pin is a caller misconfiguration (e.g. an unset\n  // config value joined into ''), NOT \"no pin\" — treating it as absent would\n  // silently disable the group-key pin (fail-open by omission). Fail closed:\n  // a pin must be a real pubkey or absent.\n  if (context.expectedGroupPubkey !== undefined && context.expectedGroupPubkey.length === 0) {\n    return {\n      valid: false,\n      pubkey: '',\n      error: 'expectedGroupPubkey pin must be a non-empty group pubkey',\n    };\n  }",
    replace: '    : (expected ?? {});',
    intent: 'v1 validator treats an empty pin as "no pin" — the group key pin is silently disabled (F-2)',
    machine: null,
  },
  {
    id: 'M49',
    cls: 'empty-pin-acceptance',
    file: 'validator.ts',
    find: "  context: AttestationV2ValidationContext = {},\n): ValidationResult {\n  // F-2: a present-but-empty pin is a caller misconfiguration, NOT \"no pin\"\n  // — fail closed instead of silently disabling the group-key pin.\n  if (context.expectedGroupPubkey !== undefined && context.expectedGroupPubkey.length === 0) {\n    return {\n      valid: false,\n      pubkey: '',\n      error: 'expectedGroupPubkey pin must be a non-empty group pubkey',\n    };\n  }",
    replace: '  context: AttestationV2ValidationContext = {},\n): ValidationResult {',
    intent: 'v2 finality validator silently disables the pin on an empty string (F-2)',
    machine: null,
  },
  {
    id: 'M50',
    cls: 'empty-pin-acceptance',
    file: 'batchAttestation.ts',
    find: "    if (ctx?.expectedGroupPubkey !== undefined && ctx.expectedGroupPubkey.length === 0) {\n      return {\n        valid: false,\n        reason: 'expectedGroupPubkey pin must be a non-empty group pubkey',\n      };\n    }",
    replace: '',
    intent: 'batch attestation validation disables the cohort pin on an empty string (F-2)',
    machine: null,
  },

  // ── batch proof bounds / duplicate verdicts ──────────────────────────────
  {
    id: 'M51',
    cls: 'proof-bounds',
    file: 'batchAttestation.ts',
    find: "    if (seen.has(hash)) {\n      throw new BatchAttestationError(\n        'duplicate verdictHash makes batch proofs ambiguous',\n        { invariant: 'INV-BATCH-3' },\n      );\n    }",
    replace: '',
    intent: 'duplicate verdict hashes are batched — two identical leaves make proof indices ambiguous',
    machine: null,
  },
  {
    id: 'M52',
    cls: 'proof-bounds',
    file: 'batchAttestation.ts',
    find: "  if (index >= count) {\n    return { valid: false, reason: 'Proof index is outside the declared batch count' };\n  }",
    replace: "  if (index > count) {\n    return { valid: false, reason: 'Proof index is outside the declared batch count' };\n  }",
    intent: 'proof index bound off-by-one: index === count is treated as inside the batch',
    machine: null,
  },
  {
    id: 'M53',
    cls: 'proof-bounds',
    file: 'confirmationMachineHandlers.ts',
    find: "  if (supportingEventIds.length === 0) {\n    throw new CourtConfirmationTransitionError(\n      'cannot finalize a verdict with zero supporting event ids — an upheld confirmation needs a quorum of confirmations, a resolved round needs winning votes',\n    );\n  }",
    replace: '',
    intent: 'finalize mints a verdict backed by zero evidence (r3-1 guard removed)',
    machine: 'confirmation',
  },
];

/** Stable class order for reporting. */
export const CLASS_ORDER = Object.keys(CLASSES);

/** Guard: ids are unique and ordered. */
export function validateCatalogue(list = MUTANTS) {
  const seen = new Set();
  let previous = '';
  for (const m of list) {
    if (!/^M\d{2}$/.test(m.id)) throw new Error(`bad mutant id ${m.id}`);
    if (seen.has(m.id)) throw new Error(`duplicate mutant id ${m.id}`);
    if (previous && m.id <= previous) throw new Error(`mutants must be ordered by id (${previous} → ${m.id})`);
    if (!CLASSES[m.cls]) throw new Error(`${m.id}: unknown class ${m.cls}`);
    if (!m.find) throw new Error(`${m.id}: empty find`);
    if (m.find === m.replace) throw new Error(`${m.id}: no-op mutation`);
    if (!(m.machine === null || ['confirmation', 'vote', 'signing'].includes(m.machine))) {
      throw new Error(`${m.id}: bad machine ${m.machine}`);
    }
    seen.add(m.id);
    previous = m.id;
  }
  return list.length;
}
