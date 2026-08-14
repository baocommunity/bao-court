// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { verifyEvent } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import {
  COURT_HOST_KEY_ATTESTATION_DOMAIN,
  COURT_HOST_KEY_BACKUP_DOMAIN,
  COURT_HOST_KEY_BACKUP_ENVELOPE_DOMAIN,
  COURT_HOST_KEY_SUPERSESSION_DOMAIN,
  CourtHostKey,
  CourtHostKeyError,
  assertCourtHostKeyAttestation,
  assertCourtHostKeyChain,
  assertRosterHostKeyBinding,
  buildCourtHostKeyBackupEvent,
  courtHostKeyAttestationTags,
  createCourtHostKeyAttestation,
  createCourtHostKeyBackup,
  encodeCourtHostKeyAttestation,
  generateCourtHostKey,
  hashCourtHostKeyAttestation,
  parseCourtHostKeyBackupEvent,
  resolveCurrentCourtHostKeyAttestation,
  restoreCourtHostKeyFromBackup,
  rotateCourtHostKey,
  verifyCourtHostKeyAttestationEvent,
  type CourtHostKeyAttestation,
  type CourtHostKeyErrorCode,
} from '../courtHostKey';
import { SeckeyCourtSigner, type CourtEventSigner } from '../courtSigner';
import {
  CanonicalWriter,
  CourtSessionValidationError,
  type CourtSessionParameters,
} from '../courtSession';
import { BAO_COURT_JUROR_CANDIDACY_KIND, buildJurorCandidacyEvent } from '../events';
import { BAO_COURT_SHARE_BACKUP_KIND, parseShareBackupEvent } from '../dkgMessages';
import {
  buildCourtRecoveryEnvelopeEvent,
  parseCourtRecoveryEnvelopeEvent,
  type CourtRecoveryEnvelopeV1,
} from '../courtRecovery';

/** Deterministic identity signers (courtNip46.test.ts fixture style). */
const ALICE_SECKEY = '1'.repeat(64);
const BOB_SECKEY = '2'.repeat(64);
const CAROL_SECKEY = '3'.repeat(64);

const alice = new SeckeyCourtSigner(ALICE_SECKEY);
const bob = new SeckeyCourtSigner(BOB_SECKEY);

const ALICE_PUB = alice.getPublicKey();
const BOB_PUB = bob.getPublicKey();
const CAROL_PUB = new SeckeyCourtSigner(CAROL_SECKEY).getPublicKey();

const NOW = 1_800_000_000;

async function expectHostKeyError(
  fn: () => unknown | Promise<unknown>,
  code: CourtHostKeyErrorCode,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CourtHostKeyError);
    expect((error as CourtHostKeyError).code).toBe(code);
    return;
  }
  throw new Error(`expected CourtHostKeyError with code ${code}`);
}

/** Attacker-side recomputation helpers (the formats are public). */
const testTextEncoder = new TextEncoder();

function testDigestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = testTextEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

function testEnvelopeHash(value: {
  readonly version: number;
  readonly ownerPubkey: string;
  readonly hostPubkey: string;
  readonly ciphertext: string;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.ownerPubkey);
  writer.hex(value.hostPubkey);
  writer.text(value.ciphertext);
  return testDigestDomain(COURT_HOST_KEY_BACKUP_ENVELOPE_DOMAIN, writer.finish());
}

function testPayloadIntegrity(value: {
  readonly version: number;
  readonly ownerPubkey: string;
  readonly hostPubkey: string;
  readonly hostSeckey: string;
  readonly createdAt: number;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(value.version);
  writer.hex(value.ownerPubkey);
  writer.hex(value.hostPubkey);
  writer.hex(value.hostSeckey);
  writer.u64(value.createdAt);
  return testDigestDomain(COURT_HOST_KEY_BACKUP_DOMAIN, writer.finish());
}

function testSupersessionDigest(value: {
  readonly nostrPubkey: string;
  readonly hostPubkey: string;
  readonly createdAt: number;
  readonly previousHostPubkey: string;
  readonly previousAttestationHash: string;
}): string {
  const writer = new CanonicalWriter();
  writer.u8(1);
  writer.hex(value.nostrPubkey);
  writer.hex(value.hostPubkey);
  writer.u64(value.createdAt);
  writer.hex(value.previousHostPubkey);
  writer.hex(value.previousAttestationHash);
  return testDigestDomain(COURT_HOST_KEY_SUPERSESSION_DOMAIN, writer.finish());
}

function testAttestationHash(value: {
  readonly nostrPubkey: string;
  readonly hostPubkey: string;
  readonly createdAt: number;
  readonly supersedes: CourtHostKeyAttestation['supersedes'];
}): string {
  const writer = new CanonicalWriter();
  writer.u8(1);
  writer.hex(value.nostrPubkey);
  writer.hex(value.hostPubkey);
  writer.u64(value.createdAt);
  writer.u8(value.supersedes === null ? 0 : 1);
  if (value.supersedes !== null) {
    writer.hex(value.supersedes.hostPubkey);
    writer.hex(value.supersedes.attestationHash);
    writer.hex(value.supersedes.supersessionSignature);
  }
  return testDigestDomain(COURT_HOST_KEY_ATTESTATION_DOMAIN, writer.finish());
}

function flipLastHexChar(value: string): string {
  const last = value[value.length - 1];
  return `${value.slice(0, -1)}${last === '0' ? '1' : '0'}`;
}

/** Compressed host pubkey derived from a one-byte test secret (courtSession style). */
function hostKeyOf(byte: number): string {
  const secret = new Uint8Array(32);
  secret[31] = byte;
  return bytesToHex(secp256k1.getPublicKey(secret, true));
}

function sessionParams(hostPubkeys: readonly string[]): CourtSessionParameters {
  const nostrKeys = [ALICE_PUB, BOB_PUB, CAROL_PUB];
  return {
    version: 1,
    environment: 'signet',
    cryptoSuite: 'pedpop-v1-experimental',
    disputeEventId: '11'.repeat(32),
    disputeId: 'dispute:market-2140:1',
    marketId: 'market-2140',
    marketEventId: '22'.repeat(32),
    selectionEventId: '33'.repeat(32),
    blockHash: '44'.repeat(32),
    blockHeight: 250_000,
    participants: hostPubkeys.map((hostPubkey, index) => ({
      idx: index + 1,
      nostrPubkey: nostrKeys[index],
      hostPubkey,
      bondRef: `signet:bond:${index + 1}`,
      role: index === 0 ? 'juror-coordinator' : 'juror',
    })),
    threshold: Math.max(1, hostPubkeys.length - 1),
    allowedOutcomes: ['YES', 'NO'],
    attempt: 0,
    createdAt: NOW - 3_600,
    deadline: NOW + 3_600,
  };
}

function candidacyTemplate(createdAt: number): EventTemplate {
  const base = buildJurorCandidacyEvent({
    disputeId: 'dispute-2140',
    marketId: 'market-2140',
    juror: {
      nostrPubkey: ALICE_PUB,
      stakeCapacitySats: 1_000_000,
      stakeCommitment: {
        amountSats: 21_000,
        bondAddress: 'tb1qexampleaddress000',
        status: 'confirmed',
        committedAt: NOW - 7_200,
      },
      wotScore: 42,
      categories: ['general'],
      registeredAt: NOW - 86_400,
    },
    bondAmountSats: 21_000,
    bondAddress: 'tb1qexampleaddress000',
  });
  // The builder stamps its own created_at; the test pins it to the
  // attestation timestamp so every fixture is fully deterministic.
  return { ...base, created_at: createdAt };
}

async function signCandidacy(
  signer: CourtEventSigner,
  attestation: CourtHostKeyAttestation,
): Promise<NostrEvent> {
  const template = candidacyTemplate(attestation.createdAt);
  return signer.signEvent({
    kind: template.kind,
    content: template.content,
    created_at: template.created_at,
    tags: [...template.tags, ...courtHostKeyAttestationTags(attestation)],
  });
}

describe('generateCourtHostKey / destroy', () => {
  it('generates distinct on-curve keys with matching x-only form and injected createdAt', () => {
    const first = generateCourtHostKey({ now: NOW });
    const second = generateCourtHostKey({ now: NOW });
    expect(first.publicKeyHex).not.toBe(second.publicKeyHex);
    expect(() => secp256k1.Point.fromHex(first.publicKeyHex)).not.toThrow();
    expect(first.xOnlyPublicKeyHex).toBe(first.publicKeyHex.slice(2));
    expect(first.createdAt).toBe(NOW);
    expect(first.destroyed).toBe(false);
    first.destroy();
    second.destroy();
  });

  it('rejects a non-integer or negative injected clock', async () => {
    await expectHostKeyError(() => generateCourtHostKey({ now: -1 }), 'malformed');
    await expectHostKeyError(() => generateCourtHostKey({ now: 1.5 }), 'malformed');
    await expectHostKeyError(() => generateCourtHostKey({ now: Number.NaN }), 'malformed');
  });

  it('fails closed on every accessor after destroy; destroy is idempotent', async () => {
    const key = generateCourtHostKey({ now: NOW });
    expect(key.publicKeyHex).toMatch(/^(02|03)[0-9a-f]{64}$/);
    key.destroy();
    expect(key.destroyed).toBe(true);
    await expectHostKeyError(() => key.publicKeyHex, 'destroyed');
    await expectHostKeyError(() => key.xOnlyPublicKeyHex, 'destroyed');
    await expectHostKeyError(() => key.createdAt, 'destroyed');
    await expectHostKeyError(() => key.signDigest(new Uint8Array(32)), 'destroyed');
    key.destroy();
    expect(key.destroyed).toBe(true);
  });
});

describe('host-key backup', () => {
  it('round-trips generate -> backup -> restore with a working signer-equivalent', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(envelope.ownerPubkey).toBe(ALICE_PUB);
    expect(envelope.hostPubkey).toBe(key.publicKeyHex);

    const restored = await restoreCourtHostKeyFromBackup(envelope, alice, { now: NOW });
    expect(restored.publicKeyHex).toBe(key.publicKeyHex);
    expect(restored.xOnlyPublicKeyHex).toBe(key.xOnlyPublicKeyHex);
    expect(restored.createdAt).toBe(NOW);

    const digest = sha256(testTextEncoder.encode('bao-court-host-key-test'));
    const signature = restored.signDigest(digest);
    expect(
      schnorr.verify(hexToBytes(signature), digest, hexToBytes(restored.xOnlyPublicKeyHex)),
    ).toBe(true);
    key.destroy();
    restored.destroy();
  });

  it('exposes no secret-referencing member anywhere on the class surface', () => {
    const key = generateCourtHostKey({ now: NOW });
    const prototypeNames = Object.getOwnPropertyNames(CourtHostKey.prototype);
    const instanceNames = Object.getOwnPropertyNames(key);
    expect(prototypeNames).not.toContain('copySeckeyBytesInternal');
    // The secret lives in a runtime-private #field: nothing enumerable or
    // reflectable on the instance or prototype may reference it.
    expect([...prototypeNames, ...instanceNames].filter((name) => /seckey/i.test(name))).toEqual(
      [],
    );
    key.destroy();
  });

  it('never propagates a signer encrypt error verbatim — its message may embed the plaintext', async () => {
    // A hostile/compromised signer receives the backup plaintext (it must, to
    // encrypt it); if it throws an error quoting that plaintext, propagating
    // the message would exfiltrate the host secret into logs.
    let capturedPlaintext = '';
    const leakingSigner: CourtEventSigner = {
      getPublicKey: () => Promise.resolve(ALICE_PUB),
      signEvent: () => Promise.reject(new Error('unused')),
      nip44Encrypt: (_peer: string, plaintext: string) => {
        capturedPlaintext = plaintext;
        return Promise.reject(new Error(`encrypt blew up on payload: ${plaintext}`));
      },
      nip44Decrypt: () => Promise.reject(new Error('unused')),
    };
    const key = generateCourtHostKey({ now: NOW });
    let thrown: unknown;
    try {
      await createCourtHostKeyBackup(key, leakingSigner);
    } catch (error) {
      thrown = error;
    }
    expect(capturedPlaintext).not.toBe(''); // signer really saw the payload
    const leakedSecret = (JSON.parse(capturedPlaintext) as { hostSeckey: string }).hostSeckey;
    expect(thrown).toBeInstanceOf(CourtHostKeyError);
    expect((thrown as CourtHostKeyError).code).toBe('malformed');
    expect((thrown as CourtHostKeyError).message).not.toContain(leakedSecret);
    key.destroy();
  });

  it('fails typed when the signer cannot produce a public key (backup and restore)', async () => {
    const keylessSigner: CourtEventSigner = {
      getPublicKey: () => Promise.reject(new Error('bunker offline')),
      signEvent: () => Promise.reject(new Error('unused')),
      nip44Encrypt: () => Promise.reject(new Error('unused')),
      nip44Decrypt: () => Promise.reject(new Error('unused')),
    };
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    await expectHostKeyError(() => createCourtHostKeyBackup(key, keylessSigner), 'malformed');
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(envelope, keylessSigner, { now: NOW }),
      'malformed',
    );
    key.destroy();
  });

  it('rejects a restore under a different identity signer before decrypting', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(envelope, bob, { now: NOW }),
      'wrong_identity',
    );
    key.destroy();
  });

  it('rejects tampered ciphertext: envelope hash first, then decrypt failure', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);

    const withoutRehash = { ...envelope, ciphertext: `${envelope.ciphertext}AA` };
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(withoutRehash, alice, { now: NOW }),
      'envelope_hash_mismatch',
    );

    const flipped = { ...envelope, ciphertext: flipLastHexChar(envelope.ciphertext) };
    const rehashed = { ...flipped, envelopeHash: testEnvelopeHash(flipped) };
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(rehashed, alice, { now: NOW }),
      'malformed',
    );
    key.destroy();
  });

  it('rejects truncated, missing-field, extra-field, and wrong-version envelopes', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    const missing = { ...envelope } as Record<string, unknown>;
    delete missing.ciphertext;

    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(null, alice, { now: NOW }),
      'malformed',
    );
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(missing, alice, { now: NOW }),
      'malformed',
    );
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup({ ...envelope, extra: 1 }, alice, { now: NOW }),
      'malformed',
    );
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup({ ...envelope, version: 2 }, alice, { now: NOW }),
      'unsupported_version',
    );
    key.destroy();
  });

  it('catches a swapped outer hostPubkey with recomputed envelope hash at the inner cross-check', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const other = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);

    const swapped = { ...envelope, hostPubkey: other.publicKeyHex };
    const rehashed = { ...swapped, envelopeHash: testEnvelopeHash(swapped) };
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(rehashed, alice, { now: NOW }),
      'key_mismatch',
    );
    key.destroy();
    other.destroy();
  });

  it('rejects payload tampering: stale integrity, then attacker-recomputed integrity', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    const payload = JSON.parse(await alice.nip44Decrypt(ALICE_PUB, envelope.ciphertext));

    payload.hostSeckey = flipLastHexChar(payload.hostSeckey);
    const staleCiphertext = await alice.nip44Encrypt(ALICE_PUB, JSON.stringify(payload));
    const stale = { ...envelope, ciphertext: staleCiphertext };
    const staleRehashed = { ...stale, envelopeHash: testEnvelopeHash(stale) };
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(staleRehashed, alice, { now: NOW }),
      'integrity_mismatch',
    );

    payload.integrity = testPayloadIntegrity(payload);
    const forgedCiphertext = await alice.nip44Encrypt(ALICE_PUB, JSON.stringify(payload));
    const forged = { ...envelope, ciphertext: forgedCiphertext };
    const forgedRehashed = { ...forged, envelopeHash: testEnvelopeHash(forged) };
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(forgedRehashed, alice, { now: NOW }),
      'key_mismatch',
    );
    key.destroy();
  });

  it('rejects a payload secret that does not derive the recorded host key', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    const payload = JSON.parse(await alice.nip44Decrypt(ALICE_PUB, envelope.ciphertext));

    async function restoreWithPayload(mutated: Record<string, unknown>): Promise<void> {
      const ciphertext = await alice.nip44Encrypt(ALICE_PUB, JSON.stringify(mutated));
      const candidate = { ...envelope, ciphertext };
      const rehashed = { ...candidate, envelopeHash: testEnvelopeHash(candidate) };
      await restoreCourtHostKeyFromBackup(rehashed, alice, { now: NOW });
    }

    // Not a valid secp256k1 scalar.
    const invalidScalar = {
      ...payload,
      hostSeckey: 'ff'.repeat(32),
    };
    invalidScalar.integrity = testPayloadIntegrity(
      invalidScalar as Parameters<typeof testPayloadIntegrity>[0],
    );
    await expectHostKeyError(() => restoreWithPayload(invalidScalar), 'key_mismatch');

    // Valid scalar, wrong key.
    const wrongScalar = {
      ...payload,
      hostSeckey: '99'.repeat(32),
    };
    wrongScalar.integrity = testPayloadIntegrity(
      wrongScalar as Parameters<typeof testPayloadIntegrity>[0],
    );
    await expectHostKeyError(() => restoreWithPayload(wrongScalar), 'key_mismatch');

    // Self-consistent inner forgery that still disagrees with the outer envelope.
    const derived = bytesToHex(secp256k1.getPublicKey(hexToBytes('99'.repeat(32)), true));
    const innerForgery = {
      ...payload,
      hostSeckey: '99'.repeat(32),
      hostPubkey: derived,
    };
    innerForgery.integrity = testPayloadIntegrity(
      innerForgery as Parameters<typeof testPayloadIntegrity>[0],
    );
    await expectHostKeyError(() => restoreWithPayload(innerForgery), 'key_mismatch');
    key.destroy();
  });

  it('rejects a future-dated backup beyond the 300-second skew and accepts the boundary', async () => {
    const futureKey = generateCourtHostKey({ now: NOW + 300 });
    const envelope = await createCourtHostKeyBackup(futureKey, alice);

    const restored = await restoreCourtHostKeyFromBackup(envelope, alice, { now: NOW });
    expect(restored.publicKeyHex).toBe(futureKey.publicKeyHex);
    restored.destroy();

    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(envelope, alice, { now: NOW - 1 }),
      'malformed',
    );
    futureKey.destroy();
  });
});

describe('host-key attestation', () => {
  it('verifies a first-generation attestation against its candidacy event', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    expect(attestation.supersedes).toBeNull();
    expect(Object.isFrozen(attestation)).toBe(true);
    expect(courtHostKeyAttestationTags(attestation)).toEqual([
      ['hostkey', attestation.hostPubkey, hashCourtHostKeyAttestation(attestation), attestation.hostSignature],
    ]);

    const event = await signCandidacy(alice, attestation);
    expect(event.kind).toBe(BAO_COURT_JUROR_CANDIDACY_KIND);
    const verified = verifyCourtHostKeyAttestationEvent(event, attestation);
    expect(verified.hostPubkey).toBe(key.publicKeyHex);
    expect(verified).not.toBe(attestation);
    expect(Object.isFrozen(verified)).toBe(true);
    key.destroy();
  });

  it('rejects an identity graft: event author is not the attested identity', async () => {
    const key = generateCourtHostKey({ now: NOW });
    // Carol's attestation carried on Alice's legitimately signed event.
    const carolAttestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: CAROL_PUB,
    });
    const event = await signCandidacy(alice, carolAttestation);
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(event, carolAttestation),
      'tag_mismatch',
    );
    key.destroy();
  });

  it('rejects a host-direction graft and the roster gate fails closed on it', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attacker = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const event = await signCandidacy(alice, attestation);

    // Swapped host key with stale hash/signature/tags: recomputed hash disagrees.
    const swapped = { ...attestation, hostPubkey: attacker.publicKeyHex };
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(event, swapped),
      'tag_mismatch',
    );

    // Attacker fully re-attests their own key for Alice's identity but must
    // reuse Alice's signed event, whose tags commit to the victim's tuple.
    const forged = createCourtHostKeyAttestation(attacker, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(event, forged),
      'tag_mismatch',
    );

    // Even carried on the attacker's own correctly-tagged event, the roster
    // gate rejects the binding: the roster commits to the victim's host key.
    const forgedEvent = await signCandidacy(alice, forged);
    verifyCourtHostKeyAttestationEvent(forgedEvent, forged);
    const params = sessionParams([key.publicKeyHex, hostKeyOf(2), hostKeyOf(3)]);
    await expectHostKeyError(
      () => assertRosterHostKeyBinding(params, 1, forged),
      'roster_binding_mismatch',
    );
    key.destroy();
    attacker.destroy();
  });

  it('rejects created_at mismatch, duplicate hostkey tags, and a missing hostkey tag', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const tags = courtHostKeyAttestationTags(attestation);

    const wrongTime = await alice.signEvent({
      ...candidacyTemplate(NOW + 5),
      tags: [...candidacyTemplate(NOW + 5).tags, ...tags],
    });
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(wrongTime, attestation),
      'tag_mismatch',
    );

    const template = candidacyTemplate(NOW);
    const duplicated = await alice.signEvent({
      kind: template.kind,
      content: template.content,
      created_at: template.created_at,
      tags: [...template.tags, ...tags, tags[0]],
    });
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(duplicated, attestation),
      'tag_mismatch',
    );

    const missing = await alice.signEvent(candidacyTemplate(NOW));
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(missing, attestation),
      'tag_mismatch',
    );
    key.destroy();
  });

  it('re-verifies a tampered event despite a spread-preserved cached verdict', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const event = await signCandidacy(alice, attestation);

    // finalizeEvent cached a "verified" verdict on the event in a symbol
    // that object spreads preserve; naive re-verification of the tampered
    // copy would wrongly succeed.
    const tampered = { ...event, content: '{"marketId":"attacker-controlled"}' };
    expect(verifyEvent(tampered as NostrEvent)).toBe(true);
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(tampered as NostrEvent, attestation),
      'event_signature_invalid',
    );
    key.destroy();
  });
});

describe('rotation, chain resolution, and replay', () => {
  it('rotates A -> B, resolves the head, and rejects broken chains and forks', async () => {
    const keyA = generateCourtHostKey({ now: NOW });
    const attestationA = createCourtHostKeyAttestation(keyA, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const { key: keyB, attestation: attestationB } = rotateCourtHostKey({
      now: NOW + 10,
      previousKey: keyA,
      previousAttestation: attestationA,
      nostrPubkey: ALICE_PUB,
    });
    expect(attestationB.supersedes?.hostPubkey).toBe(keyA.publicKeyHex);
    expect(attestationB.supersedes?.attestationHash).toBe(
      hashCourtHostKeyAttestation(attestationA),
    );

    assertCourtHostKeyChain([attestationA, attestationB]);
    const head = resolveCurrentCourtHostKeyAttestation([attestationA, attestationB]);
    expect(head).toEqual(attestationB);

    // The rotation attestation verifies against its candidacy event with the
    // previous attestation supplied.
    const eventB = await signCandidacy(alice, attestationB);
    const verifiedB = verifyCourtHostKeyAttestationEvent(eventB, attestationB, {
      previousAttestation: attestationA,
    });
    expect(verifiedB.hostPubkey).toBe(keyB.publicKeyHex);

    // Presenting only the rotated head (its ancestry withheld) is detectable.
    await expectHostKeyError(
      () => assertCourtHostKeyChain([attestationB]),
      'supersession_mismatch',
    );
    await expectHostKeyError(
      () => resolveCurrentCourtHostKeyAttestation([attestationB]),
      'supersession_mismatch',
    );

    // A fork (double rotation from the same predecessor) fails closed.
    const fork = rotateCourtHostKey({
      now: NOW + 20,
      previousKey: keyA,
      previousAttestation: attestationA,
      nostrPubkey: ALICE_PUB,
    });
    await expectHostKeyError(
      () => resolveCurrentCourtHostKeyAttestation([attestationA, attestationB, fork.attestation]),
      'chain_conflict',
    );
    keyA.destroy();
    keyB.destroy();
    fork.key.destroy();
  });

  it('rejects mis-signed supersessions, wrong previous keys, and non-monotonic timestamps', async () => {
    const keyA = generateCourtHostKey({ now: NOW });
    const attestationA = createCourtHostKeyAttestation(keyA, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const previousHash = hashCourtHostKeyAttestation(attestationA);

    // Supersession signed by the NEW key instead of the old.
    const keyB = generateCourtHostKey({ now: NOW + 30 });
    const digest = testSupersessionDigest({
      nostrPubkey: ALICE_PUB,
      hostPubkey: keyB.publicKeyHex,
      createdAt: NOW + 30,
      previousHostPubkey: keyA.publicKeyHex,
      previousAttestationHash: previousHash,
    });
    const supersedes = {
      hostPubkey: keyA.publicKeyHex,
      attestationHash: previousHash,
      supersessionSignature: keyB.signDigest(hexToBytes(digest)),
    };
    const badAttestation: CourtHostKeyAttestation = {
      version: 1,
      nostrPubkey: ALICE_PUB,
      hostPubkey: keyB.publicKeyHex,
      createdAt: NOW + 30,
      supersedes,
      hostSignature: keyB.signDigest(
        hexToBytes(
          testAttestationHash({
            nostrPubkey: ALICE_PUB,
            hostPubkey: keyB.publicKeyHex,
            createdAt: NOW + 30,
            supersedes,
          }),
        ),
      ),
    };
    const badEvent = await signCandidacy(alice, badAttestation);
    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(badEvent, badAttestation),
      'invalid_signature',
    );

    // Previous key that does not match the previous attestation.
    const unrelated = generateCourtHostKey({ now: NOW });
    await expectHostKeyError(
      () =>
        createCourtHostKeyAttestation(keyB, {
          now: NOW + 40,
          nostrPubkey: ALICE_PUB,
          supersedes: { previousKey: unrelated, previousAttestation: attestationA },
        }),
      'supersession_mismatch',
    );

    // Correctly signed but non-monotonic timestamp.
    const keyC = generateCourtHostKey({ now: NOW });
    const staleDigest = testSupersessionDigest({
      nostrPubkey: ALICE_PUB,
      hostPubkey: keyC.publicKeyHex,
      createdAt: NOW,
      previousHostPubkey: keyA.publicKeyHex,
      previousAttestationHash: previousHash,
    });
    const staleSupersedes = {
      hostPubkey: keyA.publicKeyHex,
      attestationHash: previousHash,
      supersessionSignature: keyA.signDigest(hexToBytes(staleDigest)),
    };
    const staleAttestation: CourtHostKeyAttestation = {
      version: 1,
      nostrPubkey: ALICE_PUB,
      hostPubkey: keyC.publicKeyHex,
      createdAt: NOW,
      supersedes: staleSupersedes,
      hostSignature: keyC.signDigest(
        hexToBytes(
          testAttestationHash({
            nostrPubkey: ALICE_PUB,
            hostPubkey: keyC.publicKeyHex,
            createdAt: NOW,
            supersedes: staleSupersedes,
          }),
        ),
      ),
    };
    await expectHostKeyError(
      () => assertCourtHostKeyChain([attestationA, staleAttestation]),
      'supersession_mismatch',
    );
    keyA.destroy();
    keyB.destroy();
    keyC.destroy();
    unrelated.destroy();
  });

  it('rejects a rotation whose previous key was destroyed', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    key.destroy();
    await expectHostKeyError(
      () =>
        rotateCourtHostKey({
          now: NOW + 1,
          previousKey: key,
          previousAttestation: attestation,
          nostrPubkey: ALICE_PUB,
        }),
      'destroyed',
    );
  });
});

describe('roster binding composition', () => {
  it('passes a matching attestation and rejects wrong entries and unknown indices', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const params = sessionParams([key.publicKeyHex, hostKeyOf(2), hostKeyOf(3)]);

    assertRosterHostKeyBinding(params, 1, attestation);
    await expectHostKeyError(
      () => assertRosterHostKeyBinding(params, 2, attestation),
      'roster_binding_mismatch',
    );

    try {
      assertRosterHostKeyBinding(params, 4, attestation);
      throw new Error('expected participant_not_found');
    } catch (error) {
      expect(error).toBeInstanceOf(CourtSessionValidationError);
      expect((error as CourtSessionValidationError).code).toBe('participant_not_found');
    }
    key.destroy();
  });

  it('runs session validation first: a duplicated roster host key fails upstream', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const params = sessionParams([key.publicKeyHex, key.publicKeyHex, hostKeyOf(3)]);

    try {
      assertRosterHostKeyBinding(params, 1, attestation);
      throw new Error('expected duplicate_participant_key');
    } catch (error) {
      expect(error).toBeInstanceOf(CourtSessionValidationError);
      expect((error as CourtSessionValidationError).code).toBe('duplicate_participant_key');
    }
    key.destroy();
  });
});

describe('boundary and cross-artifact behavior', () => {
  it('pins the canonical attestation encoding and hash; binds a 1-participant roster', () => {
    // Seckey = 1 fixes the host key to the secp256k1 generator point.
    const goldenKey = new CourtHostKey(hexToBytes('0'.repeat(63) + '1'), NOW);
    const attestation = createCourtHostKeyAttestation(goldenKey, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    expect(attestation.hostPubkey).toBe(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    );
    expect(bytesToHex(encodeCourtHostKeyAttestation(attestation))).toMatchInlineSnapshot(`"01000000204f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa000000210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798000000006b49d20000"`);
    expect(hashCourtHostKeyAttestation(attestation)).toMatchInlineSnapshot(`"ceece4a30097532c47501a61344b1b21905b2cf73272c3e30fdc0823886d3a51"`);

    const withSupersedes: CourtHostKeyAttestation = {
      version: 1,
      nostrPubkey: ALICE_PUB,
      hostPubkey: attestation.hostPubkey,
      createdAt: NOW + 1,
      supersedes: {
        hostPubkey: attestation.hostPubkey,
        attestationHash: 'bb'.repeat(32),
        supersessionSignature: 'cc'.repeat(64),
      },
      hostSignature: 'dd'.repeat(64),
    };
    expect(hashCourtHostKeyAttestation(withSupersedes)).toMatchInlineSnapshot(`"f59449376aa8d979b367743f67f4b3458423ad28fa3b6025e3278e16d3cb36f7"`);

    const single = sessionParams([goldenKey.publicKeyHex]);
    assertRosterHostKeyBinding(single, 1, attestation);
    goldenKey.destroy();
  });

  it('rejects cross-artifact confusion in both directions', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const attestation = createCourtHostKeyAttestation(key, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const event = await signCandidacy(alice, attestation);
    const envelope = await createCourtHostKeyBackup(key, alice);

    await expectHostKeyError(
      () => verifyCourtHostKeyAttestationEvent(event, envelope),
      'malformed',
    );
    await expectHostKeyError(
      () => restoreCourtHostKeyFromBackup(attestation, alice, { now: NOW }),
      'malformed',
    );
    await expectHostKeyError(
      () => assertCourtHostKeyAttestation({ ...attestation, unexpected: true }),
      'malformed',
    );
    key.destroy();
  });

  it('restores on a second device and passes attestation plus roster binding', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);

    const device2 = new SeckeyCourtSigner(ALICE_SECKEY);
    const restored = await restoreCourtHostKeyFromBackup(envelope, device2, { now: NOW });
    expect(restored.publicKeyHex).toBe(key.publicKeyHex);

    const attestation = createCourtHostKeyAttestation(restored, {
      now: NOW,
      nostrPubkey: ALICE_PUB,
    });
    const event = await signCandidacy(device2, attestation);
    const verified = verifyCourtHostKeyAttestationEvent(event, attestation);
    expect(verified.hostPubkey).toBe(key.publicKeyHex);

    const params = sessionParams([key.publicKeyHex, hostKeyOf(2), hostKeyOf(3)]);
    assertRosterHostKeyBinding(params, 1, verified);
    key.destroy();
    restored.destroy();
  });

  it('destroy is local-only: a pre-destroy backup still restores and no secret escapes', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    const publicKey = key.publicKeyHex;
    key.destroy();

    await expectHostKeyError(() => key.signDigest(new Uint8Array(32)), 'destroyed');
    await expectHostKeyError(() => key.publicKeyHex, 'destroyed');

    const restored = await restoreCourtHostKeyFromBackup(envelope, alice, { now: NOW });
    expect(restored.publicKeyHex).toBe(publicKey);
    restored.destroy();
  });
});

describe('kind-39100 host-key backup transport', () => {
  it('round-trips templates and discriminates legacy, recovery-style, and foreign payloads', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);
    const template = buildCourtHostKeyBackupEvent(envelope, { now: NOW });
    expect(template.kind).toBe(BAO_COURT_SHARE_BACKUP_KIND);
    expect(template.created_at).toBe(NOW);
    expect(template.tags).toContainEqual(['v', 'host-key-backup:1']);
    expect(template.tags).toContainEqual(['hostkey', key.publicKeyHex]);

    const parsed = parseCourtHostKeyBackupEvent({ ...template, pubkey: ALICE_PUB });
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(envelope);

    // Legacy un-versioned 39100 share backup: rejected by the new parser,
    // still accepted by the legacy parser.
    const legacyEvent = {
      kind: BAO_COURT_SHARE_BACKUP_KIND,
      created_at: NOW,
      pubkey: ALICE_PUB,
      tags: [
        ['d', 'dispute-2140:1'],
        ['dispute', 'dispute-2140'],
        ['juror', '1', ALICE_PUB],
      ],
      content: JSON.stringify({
        disputeId: 'dispute-2140',
        jurorIdx: 1,
        jurorPubkey: ALICE_PUB,
        encryptedShare: 'ee'.repeat(32),
        groupPubkey: 'ff'.repeat(32),
        verificationShares: [],
        vssCommitments: [],
      }),
    };
    expect(parseCourtHostKeyBackupEvent(legacyEvent)).toBeNull();
    expect(parseShareBackupEvent(legacyEvent)).not.toBeNull();

    // Host-key backup is rejected by the legacy parser.
    expect(parseShareBackupEvent({ ...template, pubkey: ALICE_PUB })).toBeNull();

    // Real recovery-module artifacts: a genuine recovery envelope event must
    // discriminate to null in the host-key parser, and vice versa.
    const recoveryEnvelope: CourtRecoveryEnvelopeV1 = {
      version: 1,
      cryptoSuite: 'pedpop-v1-experimental',
      sessionHash: 'aa'.repeat(32),
      jurorPubkey: ALICE_PUB,
      createdAt: NOW,
      ciphertext: template.content,
    };
    const recoveryEvent = buildCourtRecoveryEnvelopeEvent(recoveryEnvelope, {
      disputeId: 'dispute-2140',
      jurorIdx: 1,
      now: NOW,
    });
    expect(parseCourtHostKeyBackupEvent({ ...recoveryEvent, pubkey: ALICE_PUB })).toBeNull();
    expect(parseCourtRecoveryEnvelopeEvent({ ...template, pubkey: ALICE_PUB })).toBeNull();
    key.destroy();
  });

  it('refuses to build over a tampered envelope and rejects tag/content disagreement', async () => {
    const key = generateCourtHostKey({ now: NOW });
    const other = generateCourtHostKey({ now: NOW });
    const envelope = await createCourtHostKeyBackup(key, alice);

    const tampered = { ...envelope, hostPubkey: other.publicKeyHex };
    await expectHostKeyError(
      () => buildCourtHostKeyBackupEvent(tampered, { now: NOW }),
      'envelope_hash_mismatch',
    );

    const template = buildCourtHostKeyBackupEvent(envelope, { now: NOW });
    const tagMismatch = {
      ...template,
      tags: [
        ['v', 'host-key-backup:1'],
        ['hostkey', other.publicKeyHex],
      ],
    };
    expect(parseCourtHostKeyBackupEvent(tagMismatch)).toBeNull();
    key.destroy();
    other.destroy();
  });
});
