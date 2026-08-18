// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';

import { hashCommit, tallyVotes, deriveDisputeGroupPubkey } from '../dispute';
import type { JurorVote } from '../types';

describe('dispute helpers', () => {
  it('hashCommit separates outcome/salt that alias under | (2026-08-18 review)', () => {
    // Old encoding: sha256(`${outcome}|${salt}`) — 'YES|s' + 'alt' and
    // 'YES' + 's|alt' both produced 'YES|s|alt'. Length-prefixing must
    // separate every pair.
    const a = hashCommit('YES|s', 'alt');
    const b = hashCommit('YES', 's|alt');
    expect(a).not.toBe(b);
  });

  it('hashCommit is deterministic and sensitive to salt', () => {
    const h1 = hashCommit('YES', 'salt-a');
    const h2 = hashCommit('YES', 'salt-b');
    const h3 = hashCommit('NO', 'salt-a');
    const h4 = hashCommit('YES', 'salt-a');

    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toBe(h4);
  });

  it('tallyVotes picks the majority outcome', () => {
    const votes: JurorVote[] = [
      { idx: 1, pubkey: 'a'.repeat(64), commit: hashCommit('YES', 's1'), reveal: { outcome: 'YES', salt: 's1' } },
      { idx: 2, pubkey: 'b'.repeat(64), commit: hashCommit('YES', 's2'), reveal: { outcome: 'YES', salt: 's2' } },
      { idx: 3, pubkey: 'c'.repeat(64), commit: hashCommit('NO', 's3'), reveal: { outcome: 'NO', salt: 's3' } },
    ];

    const result = tallyVotes(votes);
    expect(result.outcome).toBe('YES');
    expect(result.supportingVotes).toHaveLength(2);
  });

  it('tallyVotes breaks ties deterministically (lexicographically smallest outcome)', () => {
    // Two-way tie; verdict must not depend on reveal arrival order and must
    // match courtVoteMachine.finalize_tally, which picks the
    // lexicographically smallest outcome on equal counts.
    const votes: JurorVote[] = [
      { idx: 1, pubkey: 'a'.repeat(64), commit: hashCommit('YES', 's1'), reveal: { outcome: 'YES', salt: 's1' } },
      { idx: 2, pubkey: 'b'.repeat(64), commit: hashCommit('NO', 's2'), reveal: { outcome: 'NO', salt: 's2' } },
    ];
    const forward = tallyVotes(votes);
    const reversed = tallyVotes([...votes].reverse());
    expect(forward.outcome).toBe('NO'); // 'NO' < 'YES' lexicographically
    expect(forward.outcome).toBe(reversed.outcome);
  });

  it('tallyVotes skips commit-reveal mismatches instead of aborting', () => {
    const votes: JurorVote[] = [
      { idx: 1, pubkey: 'a'.repeat(64), commit: hashCommit('YES', 's1'), reveal: { outcome: 'YES', salt: 's1' } },
      { idx: 2, pubkey: 'b'.repeat(64), commit: hashCommit('YES', 's2'), reveal: { outcome: 'YES', salt: 's2' } },
      // Malicious/malformed reveal: must not DoS the honest majority
      // (matches CourtVoteMachine, which refuses mismatched reveals at accept).
      { idx: 3, pubkey: 'c'.repeat(64), commit: hashCommit('NO', 's3'), reveal: { outcome: 'YES', salt: 's3' } },
    ];

    const result = tallyVotes(votes);
    expect(result.outcome).toBe('YES');
    expect(result.supportingVotes).toHaveLength(2);
    expect(result.invalidReveals).toHaveLength(1);
    expect(result.invalidReveals[0].idx).toBe(3);
  });

  it('deriveDisputeGroupPubkey returns a valid x-only pubkey', () => {
    const pk = deriveDisputeGroupPubkey('g'.repeat(64), 'd'.repeat(64));
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
    // Derivation is deterministic.
    expect(pk).toBe(deriveDisputeGroupPubkey('g'.repeat(64), 'd'.repeat(64)));
  });
});
