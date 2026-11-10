// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * INDEPENDENT reference tally for the plurality + tie-break contract
 * (differential-parity round 8 — see __tests__/differentialParity.test.ts).
 *
 * Production (courtVoteMachine.ts finalize_tally): imperative map loop that
 * tracks (winner, winnerCount) with an inline replace condition, then sorts
 * the winner's event ids with default Array#sort.
 *
 * Reference (this file): a single `reduce` over the reveal ledger building
 * the count map, a `reduce` over the entries picking the winner, and a
 * Buffer.compare-based UTF-8 byte ordering for the tie-break — a different
 * code shape at every step.
 */

export interface RefReveal {
  readonly outcome: string;
  readonly eventId: string;
}

export interface RefTallyResult {
  readonly outcome: string;
  readonly eventIds: readonly string[];
}

/** UTF-8 bytewise order via Buffer.compare (production: compareOutcomeUtf8 loop). */
export function refBytewiseUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Independent plurality winner with the protocol tie-break (smallest UTF-8
 * byte order wins a tied count). Throws on an empty ledger — mirroring the
 * machine's fail-closed "cannot finalize without any valid reveal".
 */
export function refPluralityTally(reveals: readonly RefReveal[]): RefTallyResult {
  if (!Array.isArray(reveals) || reveals.length === 0) {
    throw new RangeError('ref: tally requires at least one reveal');
  }
  const counts = reveals.reduce<Map<string, string[]>>((accumulator, reveal) => {
    const existing = accumulator.get(reveal.outcome);
    accumulator.set(
      reveal.outcome,
      existing === undefined ? [reveal.eventId] : [...existing, reveal.eventId],
    );
    return accumulator;
  }, new Map<string, string[]>());

  const [winnerOutcome, winnerEventIds] = [...counts.entries()].reduce(
    (best, entry) => {
      if (entry[1].length > best[1].length) return entry;
      if (entry[1].length === best[1].length && refBytewiseUtf8Compare(entry[0], best[0]) < 0) {
        return entry;
      }
      return best;
    },
  );

  const eventIds = [...winnerEventIds]
    .map((id) => id.toLowerCase())
    .sort(refBytewiseUtf8Compare);
  return { outcome: winnerOutcome, eventIds };
}
