// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * JIT FROST appeal phase timing defaults and boundary helpers.
 */

import type { AppealPhase, AppealTimings } from './types';

export const DEFAULT_APPEAL_TIMINGS: AppealTimings = {
  disputeWindowSeconds: 24 * 60 * 60,       // 1 day
  optInWindowSeconds: 24 * 60 * 60,         // 1 day
  selectionDeadlineSeconds: 2 * 60 * 60,    // 2 hours
  dkgWindowSeconds: 24 * 60 * 60,           // 1 day
  voteCommitWindowSeconds: 12 * 60 * 60,    // 12 hours
  voteRevealWindowSeconds: 12 * 60 * 60,    // 12 hours
  signingWindowSeconds: 12 * 60 * 60,       // 12 hours
  claimWindowSeconds: 7 * 24 * 60 * 60,     // 7 days
  reselectionWindowSeconds: 24 * 60 * 60,   // 24 hours
  seedBlockConfirmations: 6,
};

export const TEST_APPEAL_TIMINGS: AppealTimings = {
  disputeWindowSeconds: 60,
  optInWindowSeconds: 60,
  selectionDeadlineSeconds: 30,
  dkgWindowSeconds: 60,
  voteCommitWindowSeconds: 30,
  voteRevealWindowSeconds: 30,
  signingWindowSeconds: 30,
  claimWindowSeconds: 60,
  reselectionWindowSeconds: 60,
  seedBlockConfirmations: 1,
};

interface PhaseBounds {
  readonly phase: AppealPhase;
  readonly startsAt: number;
  readonly endsAt: number;
}

/**
 * Compute absolute phase boundaries from the market-resolution timestamp.
 */
export function computePhaseBounds(
  resolutionTimestamp: number,
  timings: AppealTimings = DEFAULT_APPEAL_TIMINGS,
): readonly PhaseBounds[] {
  let cursor = resolutionTimestamp;
  const advance = (seconds: number): { readonly startsAt: number; readonly endsAt: number } => {
    const startsAt = cursor;
    cursor += seconds;
    return { startsAt, endsAt: cursor };
  };

  const dispute = advance(timings.disputeWindowSeconds);
  const optIn = advance(timings.optInWindowSeconds);
  const selectionStart = cursor;
  const selectionEnd = cursor + timings.selectionDeadlineSeconds;
  cursor = selectionEnd;
  const dkg = advance(timings.dkgWindowSeconds);
  const voteCommit = advance(timings.voteCommitWindowSeconds);
  const voteReveal = advance(timings.voteRevealWindowSeconds);
  const signing = advance(timings.signingWindowSeconds);
  const claimStart = cursor;
  const claimEnd = cursor + timings.claimWindowSeconds;

  return [
    { phase: 'dispute', startsAt: dispute.startsAt, endsAt: dispute.endsAt },
    { phase: 'opt-in', startsAt: optIn.startsAt, endsAt: optIn.endsAt },
    { phase: 'selection', startsAt: selectionStart, endsAt: selectionEnd },
    { phase: 'dkg', startsAt: dkg.startsAt, endsAt: dkg.endsAt },
    { phase: 'vote-commit', startsAt: voteCommit.startsAt, endsAt: voteCommit.endsAt },
    { phase: 'vote-reveal', startsAt: voteReveal.startsAt, endsAt: voteReveal.endsAt },
    { phase: 'signing', startsAt: signing.startsAt, endsAt: signing.endsAt },
    { phase: 'claim', startsAt: claimStart, endsAt: claimEnd },
    { phase: 'refund', startsAt: claimEnd, endsAt: Number.MAX_SAFE_INTEGER },
  ];
}

/**
 * Return the active appeal phase for a given current time.
 */
export function getActivePhase(
  resolutionTimestamp: number,
  nowSeconds: number,
  timings: AppealTimings = DEFAULT_APPEAL_TIMINGS,
): AppealPhase {
  const bounds = computePhaseBounds(resolutionTimestamp, timings);
  const active = bounds.find((b) => nowSeconds >= b.startsAt && nowSeconds < b.endsAt);
  return active?.phase ?? 'refund';
}

/**
 * Return true if the current time is within any appeal phase before refund.
 */
export function isAppealActive(
  resolutionTimestamp: number,
  nowSeconds: number,
  timings: AppealTimings = DEFAULT_APPEAL_TIMINGS,
): boolean {
  const phase = getActivePhase(resolutionTimestamp, nowSeconds, timings);
  return phase !== 'refund';
}

/**
 * Seconds remaining until the next appeal phase begins, 0 once in the
 * terminal refund phase.
 */
export function secondsUntilNextPhase(
  resolutionTimestamp: number,
  nowSeconds: number,
  timings: AppealTimings = DEFAULT_APPEAL_TIMINGS,
): number {
  const bounds = computePhaseBounds(resolutionTimestamp, timings);
  const active = bounds.find((b) => nowSeconds >= b.startsAt && nowSeconds < b.endsAt);
  if (!active) {
    return 0;
  }

  return Math.max(0, active.endsAt - nowSeconds);
}
