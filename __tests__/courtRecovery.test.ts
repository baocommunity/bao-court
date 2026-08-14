// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import {
  COURT_RECOVERY_ENVELOPE_DOMAIN,
  COURT_RECOVERY_ENVELOPE_KIND,
  COURT_RECOVERY_LEGACY_SUITE,
  CourtRecoveryError,
  buildCourtRecoveryEnvelopeEvent,
  createCourtRecoveryEnvelope,
  hashCourtRecoveryPayload,
  parseCourtRecoveryEnvelopeEvent,
  restoreCourtRecovery,
  serializeCourtRecoveryPayloadV1,
  type CourtRecoveryEnvelopeV1,
  type CourtRecoveryErrorCode,
  type CourtRecoveryPayloadV1,
  type CourtRecoveredDkg,
} from '../courtRecovery';
import { hashCourtSessionParameters, type CourtSessionParameters } from '../courtSession';
import { SeckeyCourtSigner } from '../courtSigner';
import { deriveXOnlyPubkey } from '../crypto';
import { PedersenDkgAdapter } from '../dkg';
import { parseShareBackupEvent } from '../dkgMessages';
import type { DkgRecord, SelectedJuror } from '../types';

const NOW = 1_787_100_000;
const JUROR = 2; // one-based index of the juror under test

const seckeyHex = (n: number): string => n.toString(16).padStart(64, '0');
const signers = [1, 2, 3].map((n) => new SeckeyCourtSigner(seckeyHex(n)));
const pubkeys = signers.map((signer) => signer.getPublicKey());
const outsiderSigner = new SeckeyCourtSigner(seckeyHex(9));
const outsiderPubkey = outsiderSigner.getPublicKey();

function hostPubkey(n: number): string {
  const secret = new Uint8Array(32);
  secret[31] = n;
  return bytesToHex(secp256k1.getPublicKey(secret, true));
}

function sessionParameters(): CourtSessionParameters {
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
    disputeEventId: '11'.repeat(32),
    disputeId: 'dispute:market-2140:1',
    marketId: 'market-2140',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_000,
    participants: pubkeys.map((nostrPubkey, offset) => ({
      idx: offset + 1,
      nostrPubkey,
      hostPubkey: hostPubkey(offset + 1),
      bondRef: `signet:bond:${offset + 1}`,
      role: offset === 0 ? ('juror-coordinator' as const) : ('juror' as const),
    })),
    threshold: 2,
    allowedOutcomes: ['YES', 'NO'],
    attempt: 0,
    createdAt: NOW - 3_600,
    deadline: NOW + 86_400,
  };
}

const session = sessionParameters();

function makeJuror(idx: number, nostrPubkey: string): SelectedJuror {
  return {
    idx,
    nostrPubkey,
    stakeCapacitySats: 10_000,
    stakeCommitment: {
      amountSats: 10_000,
      bondAddress: 'tb1qexample',
      status: 'confirmed',
      committedAt: 1_700_000_000,
    },
    wotScore: 80,
    categories: ['world'],
    registeredAt: 1_700_000_000,
    priority: idx,
  };
}

const jurors = pubkeys.map((pubkey, offset) => makeJuror(offset + 1, pubkey));

function runDkg(seed: string, marketId: string, disputeId: string) {
  return new PedersenDkgAdapter({ unsafeTestMode: true }).run({
    marketId,
    disputeId,
    threshold: session.threshold,
    jurors,
    seed,
  });
}

const { record, shares } = runDkg('bao-court-recovery-phase5', session.marketId, session.disputeId);
const share = shares[JUROR - 1];
const jurorSigner = signers[JUROR - 1];
const jurorPubkey = pubkeys[JUROR - 1];

const OTHER_POINT = secp256k1.Point.BASE.multiply(9n).toHex(true);
const OTHER_XONLY = OTHER_POINT.slice(2);
const CURVE_ORDER_HEX = secp256k1.Point.Fn.ORDER.toString(16).padStart(64, '0');

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

type PayloadCore = Omit<CourtRecoveryPayloadV1, 'integrityHash'>;
type MutableCore = Mutable<PayloadCore>;
type MutableEnvelope = Mutable<CourtRecoveryEnvelopeV1>;

function baseCore(): MutableCore {
  return JSON.parse(
    JSON.stringify({
      version: 1,
      cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
      sessionHash: hashCourtSessionParameters(session),
      sessionParameters: session,
      jurorIdx: JUROR,
      jurorNostrPubkey: jurorPubkey,
      dkgRecord: record,
      localShareSeckey: share.seckey,
      backedUpAt: NOW,
    }),
  ) as MutableCore;
}

function baseEnvelope(): Promise<CourtRecoveryEnvelopeV1> {
  return createCourtRecoveryEnvelope({
    signer: jurorSigner,
    sessionParameters: session,
    record,
    share,
    now: NOW,
  });
}

/**
 * Forge an envelope from a mutated payload — the attacker model is a party
 * that could invoke nip44_encrypt on the juror's signer, so the ciphertext is
 * always validly self-decrypting. Integrity defaults to recomputed-consistent
 * so tamper tests reach the deeper recomputation gates.
 */
async function forge(
  mutate: (core: MutableCore) => void,
  opts: {
    readonly integrity?: 'recompute' | 'original' | 'placeholder';
    readonly outer?: (envelope: MutableEnvelope) => void;
    readonly signer?: SeckeyCourtSigner;
    readonly encryptTo?: string;
  } = {},
): Promise<CourtRecoveryEnvelopeV1> {
  const core = baseCore();
  const originalIntegrity = hashCourtRecoveryPayload(core);
  mutate(core);
  let integrityHash: string;
  if (opts.integrity === 'original') {
    integrityHash = originalIntegrity;
  } else if (opts.integrity === 'placeholder') {
    integrityHash = '00'.repeat(32);
  } else {
    integrityHash = hashCourtRecoveryPayload(core);
  }
  // Serialized directly (not via serializeCourtRecoveryPayloadV1) so forges
  // can carry deliberately invalid version/suite/scalar fields; the spread
  // also preserves any extra keys a tamper test injects.
  const plaintext = JSON.stringify({ ...core, integrityHash });
  const signer = opts.signer ?? jurorSigner;
  const ciphertext = await signer.nip44Encrypt(opts.encryptTo ?? jurorPubkey, plaintext);
  const envelope: MutableEnvelope = {
    version: 1,
    cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
    sessionHash: core.sessionHash,
    jurorPubkey,
    createdAt: NOW,
    ciphertext,
  };
  opts.outer?.(envelope);
  return envelope;
}

function restore(
  envelope: unknown,
  overrides: {
    readonly signer?: SeckeyCourtSigner;
    readonly sessionParameters?: CourtSessionParameters;
    readonly certificate?: {
      readonly sessionHash: string;
      readonly groupPubkey: string;
      readonly transcriptHash?: string;
    };
    readonly now?: number;
  } = {},
): Promise<CourtRecoveredDkg> {
  return restoreCourtRecovery(envelope, {
    signer: overrides.signer ?? jurorSigner,
    sessionParameters: overrides.sessionParameters ?? session,
    ...(overrides.certificate !== undefined ? { certificate: overrides.certificate } : {}),
    now: overrides.now ?? NOW,
  });
}

async function expectRecoveryError(
  run: () => unknown | Promise<unknown>,
  code: CourtRecoveryErrorCode,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtRecoveryError);
    expect((error as CourtRecoveryError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtRecoveryError with code ${code}`);
}

function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, shuffleKeys(entry)]),
    );
  }
  return value;
}

describe('green paths', () => {
  it('round-trips an envelope into an identical session, record, and share', async () => {
    const envelope = await baseEnvelope();
    const recovered = await restore(envelope);

    expect(recovered.jurorIdx).toBe(JUROR);
    expect(recovered.share).toEqual({ idx: JUROR, seckey: share.seckey });
    expect(hashCourtSessionParameters(recovered.sessionParameters)).toBe(envelope.sessionHash);
    expect(recovered.record).toEqual(record);
    expect(deriveXOnlyPubkey(recovered.share.seckey)).toBe(
      record.verificationShares[JUROR - 1].pubkey,
    );
  });

  it('encodes and hashes deterministically across input key orderings', () => {
    const core = baseCore();
    const shuffled = shuffleKeys(JSON.parse(JSON.stringify(core))) as PayloadCore;
    expect(hashCourtRecoveryPayload(shuffled)).toBe(hashCourtRecoveryPayload(core));

    const integrityHash = hashCourtRecoveryPayload(core);
    const canonical = serializeCourtRecoveryPayloadV1({ ...core, integrityHash });
    const reshuffled = serializeCourtRecoveryPayloadV1({ ...shuffled, integrityHash });
    expect(reshuffled).toBe(canonical);
    expect(COURT_RECOVERY_ENVELOPE_DOMAIN).toBe('BAO-Court/RecoveryEnvelope/v1');
  });

  it('restores cross-device from only the signer, the envelope, and independent session parameters', async () => {
    // Device A creates the backup; the "relay" round-trips it as JSON.
    const relayed = JSON.parse(JSON.stringify(await baseEnvelope())) as unknown;
    // Device B holds only a fresh signer for the same identity and session
    // parameters independently rebuilt from public events.
    const freshSigner = new SeckeyCourtSigner(seckeyHex(JUROR));
    const independentSession = sessionParameters();
    const recovered = await restore(relayed, {
      signer: freshSigner,
      sessionParameters: independentSession,
    });
    expect(recovered.share).toEqual({ idx: JUROR, seckey: share.seckey });
    expect(recovered.record).toEqual(record);
    expect(recovered.sessionParameters).toEqual(session);
    // The restored material is distinct copies, not aliases of the inputs.
    expect(recovered.sessionParameters).not.toBe(independentSession);
  });

  it('accepts a matching certificate reference and restores without one (legacy anchor)', async () => {
    const envelope = await baseEnvelope();
    const withCertificate = await restore(envelope, {
      certificate: {
        sessionHash: envelope.sessionHash,
        groupPubkey: record.groupPubkey,
        transcriptHash: '56'.repeat(32),
      },
    });
    expect(withCertificate.share.seckey).toBe(share.seckey);
    const without = await restore(envelope);
    expect(without.share.seckey).toBe(share.seckey);
    await expectRecoveryError(
      () =>
        restore(envelope, {
          certificate: { sessionHash: '78'.repeat(32), groupPubkey: record.groupPubkey },
        }),
      'certificate_mismatch',
    );
    await expectRecoveryError(
      () =>
        restore(envelope, {
          certificate: { sessionHash: envelope.sessionHash, groupPubkey: OTHER_POINT },
        }),
      'certificate_mismatch',
    );
  });
});

describe('certified creation', () => {
  it('refuses to back up a share that does not derive its verification share', async () => {
    const badScalar = (BigInt(`0x${share.seckey}`) + 1n).toString(16).padStart(64, '0');
    await expectRecoveryError(
      () =>
        createCourtRecoveryEnvelope({
          signer: jurorSigner,
          sessionParameters: session,
          record,
          share: { idx: JUROR, seckey: badScalar },
          now: NOW,
        }),
      'local_share_mismatch',
    );
  });

  it('refuses to back up a record whose group key does not recompute', async () => {
    const tamperedRecord: DkgRecord = { ...record, groupPubkey: OTHER_POINT };
    await expectRecoveryError(
      () =>
        createCourtRecoveryEnvelope({
          signer: jurorSigner,
          sessionParameters: session,
          record: tamperedRecord,
          share,
          now: NOW,
        }),
      'group_key_mismatch',
    );
  });

  it('refuses when the signer does not match the roster entry for the share index', async () => {
    await expectRecoveryError(
      () =>
        createCourtRecoveryEnvelope({
          signer: signers[0],
          sessionParameters: session,
          record,
          share,
          now: NOW,
        }),
      'roster_binding_mismatch',
    );
  });

  it('refuses to emit an envelope whose ciphertext exceeds the restore cap', async () => {
    // Certify-before-backup extends to transport: restore rejects ciphertext
    // over MAX_CIPHERTEXT_BYTES, so creation must never emit one.
    const fatSigner = {
      getPublicKey: () => jurorPubkey,
      signEvent: () => Promise.reject(new Error('unused')),
      nip44Encrypt: () => Promise.resolve('ff'.repeat(128 * 1024)),
      nip44Decrypt: () => Promise.reject(new Error('unused')),
    };
    await expectRecoveryError(
      () =>
        createCourtRecoveryEnvelope({
          signer: fatSigner,
          sessionParameters: session,
          record,
          share,
          now: NOW,
        }),
      'malformed',
    );
  });

  it('rejects non-legacy suites at creation and refuses signer encryption failure', async () => {
    const chillSession: CourtSessionParameters = {
      ...session,
      cryptoSuite: 'chilldkg-0.3+bip445-draft',
    };
    await expectRecoveryError(
      () =>
        createCourtRecoveryEnvelope({
          signer: jurorSigner,
          sessionParameters: chillSession,
          record,
          share,
          now: NOW,
        }),
      'unsupported_suite',
    );

    const brokenSigner = {
      getPublicKey: () => jurorPubkey,
      signEvent: () => Promise.reject(new Error('unused')),
      nip44Encrypt: () => Promise.reject(new Error('bunker offline')),
      nip44Decrypt: () => Promise.reject(new Error('bunker offline')),
    };
    await expectRecoveryError(
      () =>
        createCourtRecoveryEnvelope({
          signer: brokenSigner,
          sessionParameters: session,
          record,
          share,
          now: NOW,
        }),
      'encrypt_failed',
    );
  });
});

describe('payload tamper battery (consistent recomputed integrity)', () => {
  it('flags a flipped sessionHash without recomputed integrity as integrity_mismatch', async () => {
    const envelope = await forge(
      (core) => {
        core.sessionHash = '12'.repeat(32);
      },
      { integrity: 'original' },
    );
    await expectRecoveryError(() => restore(envelope), 'integrity_mismatch');
  });

  it('flags a flipped sessionHash with consistent integrity as session_hash_mismatch', async () => {
    const envelope = await forge((core) => {
      core.sessionHash = '12'.repeat(32);
    });
    await expectRecoveryError(() => restore(envelope), 'session_hash_mismatch');
  });

  it('flags a tampered sessionParameters field without recomputed integrity', async () => {
    const envelope = await forge(
      (core) => {
        core.sessionParameters.blockHeight += 1;
      },
      { integrity: 'original' },
    );
    await expectRecoveryError(() => restore(envelope), 'integrity_mismatch');
  });

  it('flags an invalid embedded session as session_invalid', async () => {
    const envelope = await forge(
      (core) => {
        core.sessionParameters.threshold = 5; // exceeds the roster size
      },
      { integrity: 'placeholder' }, // the invalid session cannot be integrity-encoded
    );
    await expectRecoveryError(() => restore(envelope), 'session_invalid');
  });

  it('flags a consistently re-hashed different attempt as wrong_session', async () => {
    const envelope = await forge((core) => {
      core.sessionParameters = { ...core.sessionParameters, attempt: 1 };
      core.sessionHash = hashCourtSessionParameters(core.sessionParameters);
    });
    await expectRecoveryError(() => restore(envelope), 'wrong_session');
  });

  it('flags a tampered jurorIdx as roster_binding_mismatch', async () => {
    const envelope = await forge((core) => {
      core.jurorIdx = 1;
    });
    await expectRecoveryError(() => restore(envelope), 'roster_binding_mismatch');
  });

  it('flags a tampered jurorNostrPubkey as envelope_binding_mismatch', async () => {
    const envelope = await forge((core) => {
      core.jurorNostrPubkey = pubkeys[0];
    });
    await expectRecoveryError(() => restore(envelope), 'envelope_binding_mismatch');
  });

  it('flags a tampered record threshold or participant count as dkg_record_malformed', async () => {
    const badThreshold = await forge((core) => {
      core.dkgRecord.threshold = 3; // commits no longer match the threshold
    });
    await expectRecoveryError(() => restore(badThreshold), 'dkg_record_malformed');
    const badParticipants = await forge((core) => {
      core.dkgRecord.participants = 2; // arrays no longer match the count
    });
    await expectRecoveryError(() => restore(badParticipants), 'dkg_record_malformed');
  });

  it('flags a tampered record marketId as record_session_mismatch', async () => {
    const envelope = await forge((core) => {
      core.dkgRecord.marketId = 'market-9999';
    });
    await expectRecoveryError(() => restore(envelope), 'record_session_mismatch');
  });

  it('flags a tampered group pubkey or x-only group key as group_key_mismatch', async () => {
    const badCompressed = await forge((core) => {
      core.dkgRecord.groupPubkey = OTHER_POINT;
    });
    await expectRecoveryError(() => restore(badCompressed), 'group_key_mismatch');
    const badXOnly = await forge((core) => {
      core.dkgRecord.groupPubkeyXOnly = OTHER_XONLY;
    });
    await expectRecoveryError(() => restore(badXOnly), 'group_key_mismatch');
  });

  it('flags a tampered verification share as verification_share_mismatch', async () => {
    const envelope = await forge((core) => {
      core.dkgRecord.verificationShares[0].pubkey = deriveXOnlyPubkey(seckeyHex(7));
    });
    await expectRecoveryError(() => restore(envelope), 'verification_share_mismatch');
  });

  it('flags swapped verification shares between two jurors', async () => {
    const envelope = await forge((core) => {
      const first = core.dkgRecord.verificationShares[0].pubkey;
      core.dkgRecord.verificationShares[0].pubkey = core.dkgRecord.verificationShares[1].pubkey;
      core.dkgRecord.verificationShares[1].pubkey = first;
    });
    await expectRecoveryError(() => restore(envelope), 'verification_share_mismatch');
  });

  it('flags a reordered jurorPubkeys array as dkg_record_malformed', async () => {
    const envelope = await forge((core) => {
      core.dkgRecord.jurorPubkeys.reverse();
    });
    await expectRecoveryError(() => restore(envelope), 'dkg_record_malformed');
  });

  it('flags a tampered VSS commitment as group_key_mismatch', async () => {
    const envelope = await forge((core) => {
      core.dkgRecord.vssCommitments[0].commits[0] = OTHER_POINT;
    });
    await expectRecoveryError(() => restore(envelope), 'group_key_mismatch');
  });

  it('flags a commitment set shorter than the threshold as dkg_record_malformed', async () => {
    const envelope = await forge((core) => {
      core.dkgRecord.vssCommitments[0].commits = core.dkgRecord.vssCommitments[0].commits.slice(1);
    });
    await expectRecoveryError(() => restore(envelope), 'dkg_record_malformed');
  });

  it('flags an incremented local share as local_share_mismatch', async () => {
    const envelope = await forge((core) => {
      core.localShareSeckey = (BigInt(`0x${core.localShareSeckey}`) + 1n)
        .toString(16)
        .padStart(64, '0');
    });
    await expectRecoveryError(() => restore(envelope), 'local_share_mismatch');
  });

  it('rejects the NEGATED local share (n - s): x-only equality is not enough', async () => {
    // BASE.multiply(n - s) === -BASE.multiply(s): same x coordinate, wrong
    // parity. Certifying the negation would return a share whose partial
    // signatures are invalid under the recorded group key.
    const negated = (secp256k1.Point.Fn.ORDER - BigInt(`0x${share.seckey}`))
      .toString(16)
      .padStart(64, '0');
    const envelope = await forge((core) => {
      core.localShareSeckey = negated;
    });
    await expectRecoveryError(() => restore(envelope), 'local_share_mismatch');
  });

  it('fails typed (not an untyped noble error) when constant commitments sum to infinity', async () => {
    // Forge: negate the sum of the first two constant commitments into the
    // third, so the group fold lands exactly on the point at infinity.
    const p1 = secp256k1.Point.fromHex(record.vssCommitments[0].commits[0]);
    const p2 = secp256k1.Point.fromHex(record.vssCommitments[1].commits[0]);
    const negatedSum = p1.add(p2).negate().toHex(true);
    const envelope = await forge((core) => {
      core.dkgRecord.vssCommitments[2].commits[0] = negatedSum;
    });
    await expectRecoveryError(() => restore(envelope), 'group_key_mismatch');
  });

  it('fails typed when a recomputed verification share is the point at infinity', async () => {
    // Forge: shift juror 1's non-constant commitment so the verification
    // point evaluated at idx 1 becomes ZERO while the group key (constant
    // terms) is untouched. Without the guard, serializing ZERO crashes with
    // an untyped noble 'bad point: ZERO'.
    const commitmentPoints = record.vssCommitments.map((entry) =>
      entry.commits.map((commit) => secp256k1.Point.fromHex(commit)),
    );
    const evalAtOne = commitmentPoints.reduce(
      (sum, commits) => commits.reduce((inner, point) => inner.add(point), sum),
      secp256k1.Point.ZERO,
    );
    const shifted = commitmentPoints[0][1].add(evalAtOne.negate()).toHex(true);
    const envelope = await forge((core) => {
      core.dkgRecord.vssCommitments[0].commits[1] = shifted;
    });
    await expectRecoveryError(() => restore(envelope), 'verification_share_mismatch');
  });

  it('rejects zero, curve-order, and non-hex local shares as invalid_share_scalar', async () => {
    const zero = await forge((core) => {
      core.localShareSeckey = '00'.repeat(32);
    });
    await expectRecoveryError(() => restore(zero), 'invalid_share_scalar');
    const atOrder = await forge((core) => {
      core.localShareSeckey = CURVE_ORDER_HEX;
    });
    await expectRecoveryError(() => restore(atOrder), 'invalid_share_scalar');
    // A non-hex share cannot even be integrity-encoded; it fails at payload
    // structure with the same scalar code.
    const nonHex = await forge(
      (core) => {
        core.localShareSeckey = 'zz'.repeat(32);
      },
      { integrity: 'placeholder' },
    );
    await expectRecoveryError(() => restore(nonHex), 'invalid_share_scalar');
  });

  it('flags a tampered backedUpAt without recomputed integrity', async () => {
    const envelope = await forge(
      (core) => {
        core.backedUpAt += 1;
      },
      { integrity: 'original' },
    );
    await expectRecoveryError(() => restore(envelope), 'integrity_mismatch');
  });

  it('flags a flipped integrityHash itself', async () => {
    const envelope = await forge(() => {}, { integrity: 'placeholder' });
    await expectRecoveryError(() => restore(envelope), 'integrity_mismatch');
  });

  it('rejects records spliced from foreign DKG runs', async () => {
    const foreign = runDkg('other-seed', 'market-9999', 'dispute:market-9999:1').record;
    const foreignEnvelope = await forge((core) => {
      core.dkgRecord = JSON.parse(JSON.stringify(foreign));
    });
    await expectRecoveryError(() => restore(foreignEnvelope), 'record_session_mismatch');

    // Same session, different ceremony: the spliced record is internally
    // consistent, but the local share no longer derives its public share.
    const altRun = runDkg('alt-seed', session.marketId, session.disputeId).record;
    const altEnvelope = await forge((core) => {
      core.dkgRecord = JSON.parse(JSON.stringify(altRun));
    });
    await expectRecoveryError(() => restore(altEnvelope), 'local_share_mismatch');
  });
});

describe('wrong session and wrong identity', () => {
  it('rejects an envelope from attempt N restored against attempt N+1 parameters', async () => {
    const envelope = await baseEnvelope();
    const nextAttempt: CourtSessionParameters = { ...session, attempt: 1 };
    await expectRecoveryError(
      () => restore(envelope, { sessionParameters: nextAttempt }),
      'wrong_session',
    );
  });

  it("rejects another juror's signer, and a forged outer wrapper reaches decrypt_failed", async () => {
    const envelope = await baseEnvelope();
    await expectRecoveryError(
      () => restore(envelope, { signer: signers[0] }),
      'wrong_identity',
    );
    // Outer jurorPubkey forged to the wrong signer: identity gate passes, but
    // the ciphertext is not for this conversation key.
    const forgedOuter = { ...envelope, jurorPubkey: pubkeys[0] };
    await expectRecoveryError(
      () => restore(forgedOuter, { signer: signers[0] }),
      'decrypt_failed',
    );
  });

  it('rejects a signer whose identity is not in the roster', async () => {
    const envelope = await forge(
      (core) => {
        core.jurorNostrPubkey = outsiderPubkey;
      },
      {
        signer: outsiderSigner,
        encryptTo: outsiderPubkey,
        outer: (env) => {
          env.jurorPubkey = outsiderPubkey;
        },
      },
    );
    await expectRecoveryError(
      () => restore(envelope, { signer: outsiderSigner }),
      'identity_not_in_roster',
    );
  });
});

describe('ciphertext corruption and attacker-chosen plaintext', () => {
  it('rejects truncated, bit-flipped, and empty ciphertexts', async () => {
    const envelope = await baseEnvelope();
    const truncated = { ...envelope, ciphertext: envelope.ciphertext.slice(0, 24) };
    await expectRecoveryError(() => restore(truncated), 'decrypt_failed');

    const replacement = envelope.ciphertext[10] === 'A' ? 'B' : 'A';
    const flipped = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, 10)}${replacement}${envelope.ciphertext.slice(11)}`,
    };
    await expectRecoveryError(() => restore(flipped), 'decrypt_failed');

    const empty = { ...envelope, ciphertext: '' };
    await expectRecoveryError(() => restore(empty), 'malformed');
  });

  it('rejects validly self-decrypting ciphertexts of attacker-chosen plaintext', async () => {
    const garbage = await jurorSigner.nip44Encrypt(jurorPubkey, 'not json {');
    const garbageEnvelope: CourtRecoveryEnvelopeV1 = {
      version: 1,
      cryptoSuite: COURT_RECOVERY_LEGACY_SUITE,
      sessionHash: hashCourtSessionParameters(session),
      jurorPubkey,
      createdAt: NOW,
      ciphertext: garbage,
    };
    await expectRecoveryError(() => restore(garbageEnvelope), 'malformed');

    const wrongShape = await jurorSigner.nip44Encrypt(jurorPubkey, JSON.stringify({ hello: 1 }));
    await expectRecoveryError(
      () => restore({ ...garbageEnvelope, ciphertext: wrongShape }),
      'malformed',
    );
  });
});

describe('version, downgrade, and suite confusion', () => {
  it('rejects version 0, version 2, and a missing version on the outer envelope', async () => {
    const envelope = await baseEnvelope();
    await expectRecoveryError(
      () => restore({ ...envelope, version: 0 }),
      'unsupported_version',
    );
    await expectRecoveryError(
      () => restore({ ...envelope, version: 2 }),
      'unsupported_version',
    );
    const missing = Object.fromEntries(
      Object.entries(envelope).filter(([key]) => key !== 'version'),
    );
    await expectRecoveryError(() => restore(missing), 'malformed');
  });

  it('rejects an inner payload version that disagrees with the outer wrapper', async () => {
    const envelope = await forge((core) => {
      (core as { version: number }).version = 2;
    }, { integrity: 'placeholder' });
    await expectRecoveryError(() => restore(envelope), 'unsupported_version');
  });

  it('rejects chilldkg and unknown suites on outer and inner layers', async () => {
    const envelope = await baseEnvelope();
    await expectRecoveryError(
      () => restore({ ...envelope, cryptoSuite: 'chilldkg-0.3+bip445-draft' }),
      'unsupported_suite',
    );
    await expectRecoveryError(
      () => restore({ ...envelope, cryptoSuite: 'rot13' }),
      'unsupported_suite',
    );
    const inner = await forge((core) => {
      (core as { cryptoSuite: string }).cryptoSuite = 'chilldkg-0.3+bip445-draft';
    }, { integrity: 'placeholder' });
    await expectRecoveryError(() => restore(inner), 'unsupported_suite');
  });

  it('keeps legacy, v1, and host-key backup parsers mutually blind', async () => {
    const envelope = await baseEnvelope();
    const v1Event = buildCourtRecoveryEnvelopeEvent(envelope, {
      disputeId: session.disputeId,
      jurorIdx: JUROR,
      now: NOW,
    });
    expect(parseCourtRecoveryEnvelopeEvent(v1Event)).not.toBeNull();
    expect(parseShareBackupEvent(v1Event)).toBeNull();

    // Legacy un-versioned kind-39100 backup (constructed directly, no builder).
    const legacyEvent = {
      kind: 39100,
      created_at: NOW,
      tags: [
        ['d', `${session.disputeId}:${JUROR}`],
        ['e', session.disputeId, '', 'root'],
        ['dispute', session.disputeId],
        ['juror', String(JUROR), jurorPubkey],
      ],
      content: JSON.stringify({
        disputeId: session.disputeId,
        jurorIdx: JUROR,
        jurorPubkey,
        encryptedShare: 'ab'.repeat(40),
        groupPubkey: record.groupPubkey,
        verificationShares: record.verificationShares,
        vssCommitments: record.vssCommitments,
      }),
    };
    expect(parseShareBackupEvent(legacyEvent)).not.toBeNull();
    expect(parseCourtRecoveryEnvelopeEvent(legacyEvent)).toBeNull();

    // Host-key backup payload sharing kind 39100 under its own v tag.
    const hostKeyEvent = {
      kind: 39100,
      created_at: NOW,
      tags: [
        ['d', `${session.disputeId}:hostkey`],
        ['v', 'host-key-backup:1'],
        ['hostkey', OTHER_POINT],
      ],
      content: JSON.stringify({ version: 1, ciphertext: 'cd'.repeat(40) }),
    };
    expect(parseCourtRecoveryEnvelopeEvent(hostKeyEvent)).toBeNull();
    expect(parseShareBackupEvent(hostKeyEvent)).toBeNull();
  });
});

describe('boundary and robustness', () => {
  it('rejects extra keys on the envelope and the payload', async () => {
    const envelope = await baseEnvelope();
    await expectRecoveryError(
      () => restore({ ...envelope, extra: true }),
      'malformed',
    );
    const payloadExtra = await forge((core) => {
      (core as Record<string, unknown>).backdoor = 'x';
    });
    await expectRecoveryError(() => restore(payloadExtra), 'malformed');
  });

  it('rejects non-canonical numbers and non-canonical hex', async () => {
    const envelope = await baseEnvelope();
    await expectRecoveryError(
      () => restore({ ...envelope, createdAt: NOW + 0.5 }),
      'malformed',
    );
    await expectRecoveryError(
      () => restore({ ...envelope, createdAt: String(NOW) }),
      'malformed',
    );
    await expectRecoveryError(
      () => restore({ ...envelope, sessionHash: envelope.sessionHash.toUpperCase() }),
      'malformed',
    );
    await expectRecoveryError(
      () => restore({ ...envelope, sessionHash: envelope.sessionHash.slice(2) }),
      'malformed',
    );
  });

  it('rejects a commitment that is not a valid curve point', async () => {
    const envelope = await forge((core) => {
      core.dkgRecord.vssCommitments[0].commits[0] = `02${'ff'.repeat(32)}`;
    });
    await expectRecoveryError(() => restore(envelope), 'invalid_curve_point');
  });

  it('never throws anything but CourtRecoveryError from restore, and only null from the parser', async () => {
    const garbage: readonly unknown[] = [
      null,
      undefined,
      42,
      'envelope',
      [],
      {},
      { version: '1' },
      { version: 1 },
      { version: 1, cryptoSuite: COURT_RECOVERY_LEGACY_SUITE },
      { version: 1, cryptoSuite: COURT_RECOVERY_LEGACY_SUITE, sessionHash: 'x' },
    ];
    for (const candidate of garbage) {
      await expectRecoveryError(() => restore(candidate), 'malformed');
    }

    const events: readonly unknown[] = [
      null,
      42,
      'event',
      {},
      { kind: 39099, tags: [], content: '{}' },
      { kind: 39100 },
      { kind: 39100, tags: 'x', content: '{}' },
      { kind: 39100, tags: [], content: '' },
      { kind: 39100, tags: [['v', 'recovery-envelope:1']], content: '{broken' },
      { kind: 39100, tags: [['v', 'recovery-envelope:1']], content: '{}' },
      { kind: 39100, tags: [['v', 'recovery-envelope:2']], content: '{}' },
    ];
    for (const event of events) {
      expect(
        parseCourtRecoveryEnvelopeEvent(
          event as Parameters<typeof parseCourtRecoveryEnvelopeEvent>[0],
        ),
      ).toBeNull();
    }
  });

  it('returns independent deep copies and never aliases caller state', async () => {
    const envelope = await baseEnvelope();
    const recovered = await restore(envelope);
    // Mutating the output and the input envelope must not affect a re-restore.
    (recovered.record.verificationShares[0] as { pubkey: string }).pubkey = '00'.repeat(32);
    (recovered.sessionParameters as { blockHeight: number }).blockHeight = 0;
    (envelope as { sessionHash: string }).sessionHash = '00'.repeat(32);
    const again = await restore(await baseEnvelope());
    expect(again.record).toEqual(record);
    expect(again.sessionParameters).toEqual(session);
    expect(again.share.seckey).toBe(share.seckey);
  });

  it('enforces the injected clock and the future-createdAt skew policy', async () => {
    const envelope = await baseEnvelope();
    const withinSkew = { ...envelope, createdAt: NOW + 300 };
    const ok = await restore(withinSkew);
    expect(ok.share.seckey).toBe(share.seckey);
    await expectRecoveryError(
      () => restore({ ...envelope, createdAt: NOW + 301 }),
      'malformed',
    );
    await expectRecoveryError(
      () => restore({ ...envelope, createdAt: -1 }),
      'malformed',
    );
    await expectRecoveryError(
      () => restore(envelope, { now: Number.NaN }),
      'malformed',
    );
  });

  it('keeps the share out of every serialized artifact and the module clock-free', async () => {
    const envelope = await baseEnvelope();
    expect(JSON.stringify(envelope)).not.toContain(share.seckey);
    const event = buildCourtRecoveryEnvelopeEvent(envelope, {
      disputeId: session.disputeId,
      jurorIdx: JUROR,
      now: NOW,
    });
    expect(event.content).not.toContain(share.seckey);
    expect(JSON.stringify(event.tags)).not.toContain(share.seckey);

    const moduleSource = readFileSync(
      fileURLToPath(new URL('../courtRecovery.ts', import.meta.url)),
      'utf8',
    );
    expect(moduleSource).not.toMatch(/Date\.now|Math\.random/);
    expect(moduleSource).not.toContain('courtHostKey');
    expect(moduleSource).not.toContain('courtKeeper');
  });
});

describe('kind-39100 transport templates', () => {
  it('builds and parses a discriminated recovery event that restores green', async () => {
    const envelope = await baseEnvelope();
    const event = buildCourtRecoveryEnvelopeEvent(envelope, {
      disputeId: session.disputeId,
      jurorIdx: JUROR,
      now: NOW,
    });
    expect(COURT_RECOVERY_ENVELOPE_KIND).toBe(39100);
    expect(event.kind).toBe(39100);
    expect(event.created_at).toBe(NOW);
    expect(event.tags).toContainEqual(['v', 'recovery-envelope:1']);
    expect(event.tags).toContainEqual(['d', `${session.disputeId}:recovery:${JUROR}`]);
    expect(event.tags).toContainEqual(['session', envelope.sessionHash]);
    expect(event.tags).toContainEqual(['suite', COURT_RECOVERY_LEGACY_SUITE]);
    expect(event.tags).toContainEqual(['juror', String(JUROR), jurorPubkey]);

    const parsed = parseCourtRecoveryEnvelopeEvent(event);
    expect(parsed).toEqual(envelope);
    const recovered = await restore(parsed);
    expect(recovered.share.seckey).toBe(share.seckey);
  });

  it('rejects tag/content splices and wrong kinds at the parser', async () => {
    const envelope = await baseEnvelope();
    const event = buildCourtRecoveryEnvelopeEvent(envelope, {
      disputeId: session.disputeId,
      jurorIdx: JUROR,
      now: NOW,
    });
    const splicedSession = {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === 'session' ? ['session', '99'.repeat(32)] : tag,
      ),
    };
    expect(parseCourtRecoveryEnvelopeEvent(splicedSession)).toBeNull();
    const splicedJuror = {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === 'juror' ? ['juror', String(JUROR), pubkeys[0]] : tag,
      ),
    };
    expect(parseCourtRecoveryEnvelopeEvent(splicedJuror)).toBeNull();
    expect(parseCourtRecoveryEnvelopeEvent({ ...event, kind: 39003 })).toBeNull();
  });
});
