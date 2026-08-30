import { describe, it, expect } from 'vitest';
import { computePhaseBounds, secondsUntilNextPhase, TEST_APPEAL_TIMINGS } from '../appealTiming';

describe('secondsUntilNextPhase', () => {
  it('returns seconds remaining in the dispute phase mid-window', () => {
    const bounds = computePhaseBounds(1000, TEST_APPEAL_TIMINGS);
    const dispute = bounds.find((b) => b.phase === 'dispute')!;
    // 30s into a 60s window -> 30s remaining
    expect(secondsUntilNextPhase(1000, 1030, TEST_APPEAL_TIMINGS)).toBe(dispute.endsAt - 1030);
  });

  it('returns full window length at phase start', () => {
    const bounds = computePhaseBounds(1000, TEST_APPEAL_TIMINGS);
    const optIn = bounds.find((b) => b.phase === 'opt-in')!;
    expect(secondsUntilNextPhase(1000, optIn.startsAt, TEST_APPEAL_TIMINGS)).toBe(TEST_APPEAL_TIMINGS.optInWindowSeconds);
  });

  it('returns 0 in the terminal refund phase', () => {
    // Far in the future: refund phase has no end
    expect(secondsUntilNextPhase(1000, Number.MAX_SAFE_INTEGER, TEST_APPEAL_TIMINGS)).toBe(0);
  });
});
