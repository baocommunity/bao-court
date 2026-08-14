// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { describe, expect, it } from 'vitest';
import {
  COURT_CAPABILITY_VERSION,
  COURT_SIGNER_CAPABILITY_DOMAIN,
  CourtCapabilityError,
  assertCourtCapabilityAction,
  assertCourtSignerCapability,
  createCourtCapability,
  describeCourtCapability,
  encodeCourtCapability,
  hashCourtCapability,
  type CourtCapabilityAction,
  type CourtSignerCapability,
} from '../courtNip46';
import {
  BAO_COURT_DKG_COMMITMENT_KIND,
  BAO_COURT_FROST_COMMIT_KIND,
  BAO_COURT_VOTE_COMMIT_KIND,
  BAO_COURT_VOTE_REVEAL_KIND,
} from '../events';

/** Deterministic lowercase 32-byte hex stand-ins for juror pubkeys. */
const key = (n: number): string => n.toString(16).padStart(64, '0');

const ROSTER = [key(1), key(2), key(3)];
const SESSION_HASH = key(0xaa);
const NOT_BEFORE = 1_800_000_000;
const NOT_AFTER = 1_800_003_600;

function baseParams(): CourtSignerCapability {
  return {
    version: COURT_CAPABILITY_VERSION,
    sessionHash: SESSION_HASH,
    cryptoSuite: 'pedpop-v1-experimental',
    environment: 'signet',
    roster: ROSTER,
    allowedPeers: [key(2), key(3)],
    allowedKinds: [BAO_COURT_VOTE_COMMIT_KIND, BAO_COURT_VOTE_REVEAL_KIND],
    phaseScope: 'vote',
    notBefore: NOT_BEFORE,
    notAfter: NOT_AFTER,
  };
}

function baseAction(): CourtCapabilityAction {
  return {
    sessionHash: SESSION_HASH,
    suite: 'pedpop-v1-experimental',
    network: 'signet',
    kind: BAO_COURT_VOTE_COMMIT_KIND,
    phase: 'vote',
    signerPubkey: key(1),
  };
}

const NOW = NOT_BEFORE + 60;

function expectCapabilityError(
  fn: () => void,
  code: string,
): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtCapabilityError);
    expect((error as CourtCapabilityError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtCapabilityError with code ${code}`);
}

describe('createCourtCapability validation', () => {
  it('accepts a fully valid capability and freezes it', () => {
    const capability = createCourtCapability(baseParams());
    expect(capability.sessionHash).toBe(SESSION_HASH);
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.roster)).toBe(true);
  });

  it('rejects a non-object capability', () => {
    expectCapabilityError(() => assertCourtSignerCapability('nope'), 'malformed');
    expectCapabilityError(() => assertCourtSignerCapability(null), 'malformed');
  });

  it('rejects unsupported fields', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), extra: 1 } as never),
      'malformed',
    );
  });

  it('rejects an unsupported version', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), version: 2 as never }),
      'malformed',
    );
  });

  it('rejects a malformed session hash', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), sessionHash: 'ABCD' }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), sessionHash: key(0xaa).toUpperCase() }),
      'malformed',
    );
  });

  it('rejects unsupported suites and environments', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), cryptoSuite: 'frost-2-of-3' as never }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), environment: 'testnet' as never }),
      'malformed',
    );
  });

  it('rejects non-hex, unsorted, duplicate, and empty rosters', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), roster: [] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), roster: [key(2), key(1), key(3)] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), roster: [key(1), key(1), key(3)] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), roster: [key(1), 'zz', key(3)] }),
      'malformed',
    );
  });

  it('rejects empty peers, unsorted peers, and peers outside the roster', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedPeers: [] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedPeers: [key(3), key(2)] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedPeers: [key(2), key(9)] }),
      'malformed',
    );
  });

  it('rejects empty, unsorted, and out-of-range kind allowlists', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedKinds: [] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedKinds: [BAO_COURT_VOTE_REVEAL_KIND, BAO_COURT_VOTE_COMMIT_KIND] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedKinds: [65_536] }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), allowedKinds: [1.5] }),
      'malformed',
    );
  });

  it('rejects an unsupported phase scope', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), phaseScope: 'settlement' as never }),
      'malformed',
    );
  });

  it('rejects an inverted or empty validity window', () => {
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), notAfter: NOT_BEFORE }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), notAfter: NOT_BEFORE - 1 }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), notBefore: -1 }),
      'malformed',
    );
    expectCapabilityError(
      () => createCourtCapability({ ...baseParams(), notAfter: Number.MAX_SAFE_INTEGER + 1 }),
      'malformed',
    );
  });
});

describe('assertCourtCapabilityAction acceptance', () => {
  it('accepts a signing action inside the matching phase scope', () => {
    const capability = createCourtCapability(baseParams());
    expect(() =>
      assertCourtCapabilityAction(capability, baseAction(), NOW),
    ).not.toThrow();
  });

  it('accepts every allowed kind in the allowlist', () => {
    const capability = createCourtCapability(baseParams());
    expect(() =>
      assertCourtCapabilityAction(
        capability,
        { ...baseAction(), kind: BAO_COURT_VOTE_REVEAL_KIND },
        NOW,
      ),
    ).not.toThrow();
  });

  it('accepts an encrypt/decrypt action to an allowed peer', () => {
    const capability = createCourtCapability(baseParams());
    expect(() =>
      assertCourtCapabilityAction(
        capability,
        { ...baseAction(), peerPubkey: key(2) },
        NOW,
      ),
    ).not.toThrow();
    expect(() =>
      assertCourtCapabilityAction(
        capability,
        { ...baseAction(), peerPubkey: key(3) },
        NOW,
      ),
    ).not.toThrow();
  });

  it('accepts every concrete phase under the all scope', () => {
    const capability = createCourtCapability({
      ...baseParams(),
      phaseScope: 'all',
      allowedKinds: [
        BAO_COURT_DKG_COMMITMENT_KIND,
        BAO_COURT_VOTE_COMMIT_KIND,
        BAO_COURT_FROST_COMMIT_KIND,
      ],
    });
    for (const [phase, kind] of [
      ['dkg', BAO_COURT_DKG_COMMITMENT_KIND],
      ['vote', BAO_COURT_VOTE_COMMIT_KIND],
      ['signing', BAO_COURT_FROST_COMMIT_KIND],
    ] as const) {
      expect(() =>
        assertCourtCapabilityAction(capability, { ...baseAction(), phase, kind }, NOW),
      ).not.toThrow();
    }
  });

  it('accepts actions by any roster juror', () => {
    const capability = createCourtCapability(baseParams());
    for (const signerPubkey of ROSTER) {
      expect(() =>
        assertCourtCapabilityAction(capability, { ...baseAction(), signerPubkey }, NOW),
      ).not.toThrow();
    }
  });

  it('accepts the window boundary instants notBefore and notAfter - 1', () => {
    const capability = createCourtCapability(baseParams());
    expect(() =>
      assertCourtCapabilityAction(capability, baseAction(), NOT_BEFORE),
    ).not.toThrow();
    expect(() =>
      assertCourtCapabilityAction(capability, baseAction(), NOT_AFTER - 1),
    ).not.toThrow();
  });
});

describe('assertCourtCapabilityAction rejection', () => {
  const capability = createCourtCapability(baseParams());

  it('rejects before the validity window opens (notBefore - 1)', () => {
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, baseAction(), NOT_BEFORE - 1),
      'not_yet_valid',
    );
  });

  it('rejects at and after the window closes (notAfter, notAfter + 1)', () => {
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, baseAction(), NOT_AFTER),
      'expired',
    );
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, baseAction(), NOT_AFTER + 1),
      'expired',
    );
  });

  it('rejects a different session hash', () => {
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(
          capability,
          { ...baseAction(), sessionHash: key(0xbb) },
          NOW,
        ),
      'session_mismatch',
    );
  });

  it('rejects a different crypto suite', () => {
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(
          capability,
          { ...baseAction(), suite: 'chilldkg-0.3+bip445-draft' },
          NOW,
        ),
      'suite_mismatch',
    );
  });

  it('rejects a different network', () => {
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, { ...baseAction(), network: 'demo' }, NOW),
      'network_mismatch',
    );
  });

  it('rejects a signer outside the roster', () => {
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(capability, { ...baseAction(), signerPubkey: key(9) }, NOW),
      'signer_not_in_roster',
    );
  });

  it('rejects an event kind outside the allowlist', () => {
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(
          capability,
          { ...baseAction(), kind: BAO_COURT_DKG_COMMITMENT_KIND },
          NOW,
        ),
      'kind_not_allowed',
    );
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, { ...baseAction(), kind: 1 }, NOW),
      'kind_not_allowed',
    );
  });

  it('rejects an action outside the phase scope', () => {
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, { ...baseAction(), phase: 'dkg' }, NOW),
      'phase_mismatch',
    );
  });

  it('rejects a peer outside the allowed set, even a roster juror', () => {
    // key(1) is in the roster but not in allowedPeers.
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, { ...baseAction(), peerPubkey: key(1) }, NOW),
      'peer_not_allowed',
    );
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, { ...baseAction(), peerPubkey: key(9) }, NOW),
      'peer_not_allowed',
    );
  });

  it('rejects malformed actions', () => {
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, null as never, NOW),
      'malformed',
    );
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(
          capability,
          { ...baseAction(), sessionHash: 'xyz' } as never,
          NOW,
        ),
      'malformed',
    );
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(capability, { ...baseAction(), phase: 'all' } as never, NOW),
      'malformed',
    );
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(capability, { ...baseAction(), kind: -1 } as never, NOW),
      'malformed',
    );
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, baseAction(), -1),
      'malformed',
    );
    expectCapabilityError(
      () => assertCourtCapabilityAction(capability, baseAction(), 1.5),
      'malformed',
    );
  });

  it('rejects a malformed capability before any action check', () => {
    expectCapabilityError(
      () =>
        assertCourtCapabilityAction(
          { ...baseParams(), roster: [key(3), key(1), key(2)] },
          baseAction(),
          NOW,
        ),
      'malformed',
    );
    expectCapabilityError(
      () => assertCourtCapabilityAction(null as never, baseAction(), NOW),
      'malformed',
    );
  });
});

describe('canonical encoding and hashing', () => {
  it('produces a deterministic 32-byte lowercase hex hash', () => {
    const capability = createCourtCapability(baseParams());
    const hash = hashCourtCapability(capability);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCourtCapability(createCourtCapability(baseParams()))).toBe(hash);
  });

  it('is invariant to object field insertion order', () => {
    const forward = baseParams();
    const reversed = Object.fromEntries(
      Object.entries(baseParams()).reverse(),
    ) as unknown as CourtSignerCapability;
    expect(hashCourtCapability(reversed)).toBe(hashCourtCapability(forward));
    expect(encodeCourtCapability(reversed)).toEqual(encodeCourtCapability(forward));
  });

  it('changes when any bound field changes', () => {
    const base = hashCourtCapability(baseParams());
    const variants: CourtSignerCapability[] = [
      { ...baseParams(), sessionHash: key(0xbb) },
      { ...baseParams(), cryptoSuite: 'chilldkg-0.3+bip445-draft' },
      { ...baseParams(), environment: 'demo' },
      { ...baseParams(), roster: [key(1), key(2), key(3), key(4)] },
      { ...baseParams(), allowedPeers: [key(2)] },
      { ...baseParams(), allowedKinds: [BAO_COURT_VOTE_COMMIT_KIND] },
      { ...baseParams(), phaseScope: 'all' },
      { ...baseParams(), notBefore: NOT_BEFORE + 1 },
      { ...baseParams(), notAfter: NOT_AFTER + 1 },
    ];
    for (const variant of variants) {
      expect(hashCourtCapability(variant)).not.toBe(base);
    }
  });

  it('is domain-separated from other Court hashes', () => {
    expect(COURT_SIGNER_CAPABILITY_DOMAIN).toBe('BAO-Court/SignerCapability/v1');
    // Same payload shape hashed by a caller under a different domain would
    // differ; here we pin the domain constant so a drift breaks loudly.
    const capability = createCourtCapability(baseParams());
    expect(hashCourtCapability(capability)).toBe(hashCourtCapability({ ...capability }));
  });
});

describe('describeCourtCapability', () => {
  it('renders a human-readable summary without granting authority', () => {
    const capability = createCourtCapability(baseParams());
    const summary = describeCourtCapability(capability);
    expect(summary).toContain(SESSION_HASH);
    expect(summary).toContain('pedpop-v1-experimental');
    expect(summary).toContain('signet');
    expect(summary).toContain(hashCourtCapability(capability));
  });
});
