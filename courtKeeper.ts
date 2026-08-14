// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Keeper designation and reveal verification for the BANOS direct-settlement
 * seam (Construction A of the Court x settlement plan; see README section 9).
 *
 * For each matched contract, two DIFFERENT jurors are designated from the
 * Court roster: keeper_yes and keeper_no. Each keeper locally generates its
 * branch secret and publishes a hash commitment; after the Court authorizes
 * resolution, the winning-branch keeper reveals. This module contains ONLY
 * the deterministic seed-derived designation, the canonical
 * designation/commitment records, and reveal verification. It holds no
 * secrets, performs no DKG, and contains no settlement logic.
 *
 * Keeper exclusion rules are hard validity constraints from the settlement
 * plan: a keeper must never be a contract participant, must never be the
 * receiver of the funds locked to the secret they keep, and must never have
 * economic exposure to the market. Violating candidates are skipped
 * deterministically by iterating the seed-derived candidate stream.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { CanonicalWriter } from './courtSession';

export const COURT_KEEPER_DESIGNATION_DOMAIN = 'BAO-Court/KeeperDesignation/v1';
export const COURT_KEEPER_COMMITMENT_DOMAIN = 'BAO-Court/KeeperCommitment/v1';
export const COURT_KEEPER_STREAM_DOMAIN = 'BAO-Court/KeeperStream/v1';

/** Settlement branch a keeper secret locks. */
export type CourtKeeperBranch = 'yes' | 'no';

export type CourtKeeperErrorCode =
  | 'invalid_params'
  | 'roster_exhausted'
  | 'keeper_not_designated'
  | 'commitment_mismatch'
  | 'reveal_mismatch'
  | 'wrong_branch';

export class CourtKeeperError extends Error {
  readonly code: CourtKeeperErrorCode;

  constructor(code: CourtKeeperErrorCode, message: string) {
    super(message);
    this.name = 'CourtKeeperError';
    this.code = code;
  }
}

/** Exclusion context every keeper designation is validated against. */
export interface CourtKeeperExclusions {
  /** Exactly two distinct trader pubkeys; neither may ever keep a secret. */
  readonly contractParticipants: readonly string[];
  /** Receiver of the funds each branch secret locks. */
  readonly branchReceivers: { readonly yes: string; readonly no: string };
  /** Jurors with economic exposure to the market. */
  readonly exposedPubkeys: readonly string[];
}

export interface DesignateKeepersParams extends CourtKeeperExclusions {
  /** 32-byte lowercase hex seed (e.g. from selection.ts deriveSelectionSeed). */
  readonly seed: string;
  /** 32-byte lowercase hex hash of the settlement manifest. */
  readonly manifestHash: string;
  /** Canonical contract identifier text. */
  readonly contractId: string;
  /** Sorted, distinct juror pubkeys (32-byte lowercase hex). */
  readonly roster: readonly string[];
}

/** The two designated keepers for one contract. */
export interface CourtKeeperPair {
  readonly keeperYes: string;
  readonly keeperNo: string;
}

/**
 * Canonical keeper designation record. Binds the draw inputs (seed, manifest
 * hash, contract id), both keeper pubkeys, and both branch secret
 * commitments into one hashable artifact.
 */
export interface CourtKeeperDesignation {
  readonly seed: string;
  readonly manifestHash: string;
  readonly contractId: string;
  readonly keeperYes: string;
  readonly keeperNo: string;
  /** SHA-256 of the yes-branch keeper secret (32-byte lowercase hex). */
  readonly yesCommitment: string;
  /** SHA-256 of the no-branch keeper secret (32-byte lowercase hex). */
  readonly noCommitment: string;
}

/** A keeper's published hash commitment to its branch secret. */
export interface CourtKeeperCommitment {
  /** hashKeeperDesignation of the designation this commitment binds to. */
  readonly designationHash: string;
  readonly branch: CourtKeeperBranch;
  /** SHA-256 of the 32-byte branch secret (32-byte lowercase hex). */
  readonly secretHash: string;
}

const textEncoder = new TextEncoder();
const HEX_32 = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_CONTRACT_ID_BYTES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new CourtKeeperError(
      'invalid_params',
      `${field} contains unsupported field ${unexpected}`,
    );
  }
}

function assertHex32(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_32.test(value)) {
    throw new CourtKeeperError('invalid_params', `${field} must be 32-byte lowercase hex`);
  }
}

function assertBranch(value: unknown, field: string): asserts value is CourtKeeperBranch {
  if (value !== 'yes' && value !== 'no') {
    throw new CourtKeeperError('invalid_params', `${field} must be 'yes' or 'no'`);
  }
}

function assertContractId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value !== value.normalize('NFC')
    || CONTROL_CHARACTERS.test(value)
    || textEncoder.encode(value).length > MAX_CONTRACT_ID_BYTES
  ) {
    throw new CourtKeeperError(
      'invalid_params',
      'contractId must be non-empty canonical UTF-8 without surrounding whitespace or control characters',
    );
  }
}

function assertRoster(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value)) {
    throw new CourtKeeperError('invalid_params', 'roster must be an array of juror pubkeys');
  }
  let previous: string | undefined;
  for (const pubkey of value) {
    assertHex32(pubkey, 'roster entry');
    if (previous !== undefined && pubkey <= previous) {
      throw new CourtKeeperError(
        'invalid_params',
        'roster must be sorted ascending with distinct pubkeys',
      );
    }
    previous = pubkey;
  }
}

function assertExclusions(value: unknown): asserts value is CourtKeeperExclusions {
  if (!isRecord(value)) {
    throw new CourtKeeperError('invalid_params', 'exclusions must be an object');
  }
  assertExactKeys(
    value,
    ['contractParticipants', 'branchReceivers', 'exposedPubkeys'],
    'exclusions',
  );
  if (!Array.isArray(value.contractParticipants) || value.contractParticipants.length !== 2) {
    throw new CourtKeeperError(
      'invalid_params',
      'contractParticipants must contain exactly the two trader pubkeys',
    );
  }
  for (const participant of value.contractParticipants) {
    assertHex32(participant, 'contractParticipants entry');
  }
  if (value.contractParticipants[0] === value.contractParticipants[1]) {
    throw new CourtKeeperError('invalid_params', 'contractParticipants must be distinct');
  }
  if (!isRecord(value.branchReceivers)) {
    throw new CourtKeeperError('invalid_params', 'branchReceivers must be an object');
  }
  assertExactKeys(value.branchReceivers, ['yes', 'no'], 'branchReceivers');
  assertHex32(value.branchReceivers.yes, 'branchReceivers.yes');
  assertHex32(value.branchReceivers.no, 'branchReceivers.no');
  if (!Array.isArray(value.exposedPubkeys)) {
    throw new CourtKeeperError('invalid_params', 'exposedPubkeys must be an array');
  }
  for (const exposed of value.exposedPubkeys) {
    assertHex32(exposed, 'exposedPubkeys entry');
  }
}

function assertDesignateParams(value: unknown): asserts value is DesignateKeepersParams {
  if (!isRecord(value)) {
    throw new CourtKeeperError('invalid_params', 'designation params must be an object');
  }
  assertExactKeys(
    value,
    [
      'seed',
      'manifestHash',
      'contractId',
      'roster',
      'contractParticipants',
      'branchReceivers',
      'exposedPubkeys',
    ],
    'designation params',
  );
  assertHex32(value.seed, 'seed');
  assertHex32(value.manifestHash, 'manifestHash');
  assertContractId(value.contractId);
  assertRoster(value.roster);
  assertExclusions({
    contractParticipants: value.contractParticipants,
    branchReceivers: value.branchReceivers,
    exposedPubkeys: value.exposedPubkeys,
  });
}

function digestDomain(domain: string, encoded: Uint8Array): string {
  const prefix = textEncoder.encode(domain);
  const input = new Uint8Array(prefix.length + encoded.length);
  input.set(prefix, 0);
  input.set(encoded, prefix.length);
  return bytesToHex(sha256(input));
}

/**
 * Deterministic seed-derived candidate stream over the roster.
 *
 * Every party can recompute this ordering from public draw inputs, exactly as
 * verifyJurySelection lets anyone recompute the jury draw. Keeper designation
 * walks this stream and takes the first eligible candidate per branch.
 */
export function keeperCandidateOrder(params: {
  readonly seed: string;
  readonly manifestHash: string;
  readonly contractId: string;
  readonly roster: readonly string[];
}): string[] {
  assertHex32(params.seed, 'seed');
  assertHex32(params.manifestHash, 'manifestHash');
  assertContractId(params.contractId);
  assertRoster(params.roster);
  const scored = params.roster.map((pubkey) => {
    const writer = new CanonicalWriter();
    writer.hex(params.seed);
    writer.hex(params.manifestHash);
    writer.text(params.contractId);
    writer.hex(pubkey);
    return { pubkey, digest: digestDomain(COURT_KEEPER_STREAM_DOMAIN, writer.finish()) };
  });
  scored.sort((a, b) => {
    if (a.digest !== b.digest) return a.digest < b.digest ? -1 : 1;
    return a.pubkey < b.pubkey ? -1 : 1;
  });
  return scored.map((entry) => entry.pubkey);
}

function isEligibleKeeper(
  candidate: string,
  branch: CourtKeeperBranch,
  exclusions: CourtKeeperExclusions,
): boolean {
  if (exclusions.contractParticipants.includes(candidate)) return false;
  if (exclusions.exposedPubkeys.includes(candidate)) return false;
  if (candidate === exclusions.branchReceivers[branch]) return false;
  return true;
}

/**
 * Deterministically designate the two branch keepers for one contract.
 *
 * keeper_yes is the first candidate in the seed-derived stream eligible for
 * the yes branch; keeper_no is the first stream candidate eligible for the
 * no branch and distinct from keeper_yes. Throws 'roster_exhausted' when the
 * eligible roster cannot supply two distinct valid keepers.
 */
export function designateKeepers(params: DesignateKeepersParams): CourtKeeperPair {
  assertDesignateParams(params);
  const order = keeperCandidateOrder(params);
  const exclusions: CourtKeeperExclusions = {
    contractParticipants: params.contractParticipants,
    branchReceivers: params.branchReceivers,
    exposedPubkeys: params.exposedPubkeys,
  };
  const keeperYes = order.find((candidate) => isEligibleKeeper(candidate, 'yes', exclusions));
  if (keeperYes === undefined) {
    throw new CourtKeeperError(
      'roster_exhausted',
      'the eligible roster cannot supply a keeper for the yes branch',
    );
  }
  const keeperNo = order.find(
    (candidate) => candidate !== keeperYes && isEligibleKeeper(candidate, 'no', exclusions),
  );
  if (keeperNo === undefined) {
    throw new CourtKeeperError(
      'roster_exhausted',
      'the eligible roster cannot supply a keeper for the no branch distinct from keeper_yes',
    );
  }
  return { keeperYes, keeperNo };
}

function assertKeeperDesignationShape(value: unknown): asserts value is CourtKeeperDesignation {
  if (!isRecord(value)) {
    throw new CourtKeeperError('invalid_params', 'keeper designation must be an object');
  }
  assertExactKeys(
    value,
    ['seed', 'manifestHash', 'contractId', 'keeperYes', 'keeperNo', 'yesCommitment', 'noCommitment'],
    'keeper designation',
  );
  assertHex32(value.seed, 'seed');
  assertHex32(value.manifestHash, 'manifestHash');
  assertContractId(value.contractId);
  assertHex32(value.keeperYes, 'keeperYes');
  assertHex32(value.keeperNo, 'keeperNo');
  assertHex32(value.yesCommitment, 'yesCommitment');
  assertHex32(value.noCommitment, 'noCommitment');
}

function assertKeeperEligibleForBranch(
  keeper: string,
  branch: CourtKeeperBranch,
  exclusions: CourtKeeperExclusions,
): void {
  if (exclusions.contractParticipants.includes(keeper)) {
    throw new CourtKeeperError(
      'keeper_not_designated',
      `keeper_${branch} is a contract participant and may never be designated`,
    );
  }
  if (keeper === exclusions.branchReceivers[branch]) {
    throw new CourtKeeperError(
      'keeper_not_designated',
      `keeper_${branch} receives the funds locked to the secret they keep`,
    );
  }
  if (exclusions.exposedPubkeys.includes(keeper)) {
    throw new CourtKeeperError(
      'keeper_not_designated',
      `keeper_${branch} has economic exposure to the market`,
    );
  }
}

/**
 * Fully validate a keeper designation record: canonical shape, every
 * exclusion rule re-checked against the record fields, and — critically —
 * recomputation of the deterministic seed-derived draw over the given
 * roster. A designation naming keepers other than the exact draw output is
 * forged, no matter how eligible the named jurors are.
 */
export function assertKeeperDesignation(
  value: unknown,
  exclusions: CourtKeeperExclusions,
  roster: readonly string[],
): asserts value is CourtKeeperDesignation {
  assertKeeperDesignationShape(value);
  assertExclusions(exclusions);
  assertRoster(roster);
  if (value.keeperYes === value.keeperNo) {
    throw new CourtKeeperError(
      'keeper_not_designated',
      'keeper_yes and keeper_no must be distinct jurors',
    );
  }
  assertKeeperEligibleForBranch(value.keeperYes, 'yes', exclusions);
  assertKeeperEligibleForBranch(value.keeperNo, 'no', exclusions);

  let expected: CourtKeeperPair;
  try {
    expected = designateKeepers({
      seed: value.seed,
      manifestHash: value.manifestHash,
      contractId: value.contractId,
      roster,
      contractParticipants: exclusions.contractParticipants,
      branchReceivers: exclusions.branchReceivers,
      exposedPubkeys: exclusions.exposedPubkeys,
    });
  } catch (err) {
    if (err instanceof CourtKeeperError && err.code === 'roster_exhausted') {
      throw new CourtKeeperError(
        'keeper_not_designated',
        'the roster cannot produce any valid designation for this contract',
      );
    }
    throw err;
  }
  if (expected.keeperYes !== value.keeperYes || expected.keeperNo !== value.keeperNo) {
    throw new CourtKeeperError(
      'keeper_not_designated',
      'designation does not match the deterministic seed-derived draw for this roster',
    );
  }
}

/**
 * Canonical binary encoding of a keeper designation under
 * 'BAO-Court/KeeperDesignation/v1'. Validates record shape only; hosts must
 * additionally run assertKeeperDesignation with the exclusion context at
 * trust boundaries.
 */
export function encodeKeeperDesignation(value: CourtKeeperDesignation): Uint8Array {
  assertKeeperDesignationShape(value);
  const writer = new CanonicalWriter();
  writer.hex(value.seed);
  writer.hex(value.manifestHash);
  writer.text(value.contractId);
  writer.hex(value.keeperYes);
  writer.hex(value.keeperNo);
  writer.hex(value.yesCommitment);
  writer.hex(value.noCommitment);
  return writer.finish();
}

/** Derive the lowercase SHA-256 keeper designation identifier. */
export function hashKeeperDesignation(value: CourtKeeperDesignation): string {
  return digestDomain(COURT_KEEPER_DESIGNATION_DOMAIN, encodeKeeperDesignation(value));
}

function assertKeeperCommitmentShape(value: unknown): asserts value is CourtKeeperCommitment {
  if (!isRecord(value)) {
    throw new CourtKeeperError('invalid_params', 'keeper commitment must be an object');
  }
  assertExactKeys(value, ['designationHash', 'branch', 'secretHash'], 'keeper commitment');
  assertHex32(value.designationHash, 'designationHash');
  assertBranch(value.branch, 'branch');
  assertHex32(value.secretHash, 'secretHash');
}

/**
 * Build a validated keeper secret commitment record binding a designation
 * hash, a branch, and the SHA-256 hash of the keeper's 32-byte secret.
 */
export function commitKeeperSecret(params: {
  readonly designationHash: string;
  readonly branch: CourtKeeperBranch;
  readonly secretHash: string;
}): CourtKeeperCommitment {
  assertKeeperCommitmentShape(params);
  return {
    designationHash: params.designationHash,
    branch: params.branch,
    secretHash: params.secretHash,
  };
}

/** Canonical binary encoding of a keeper commitment under 'BAO-Court/KeeperCommitment/v1'. */
export function encodeKeeperCommitment(value: CourtKeeperCommitment): Uint8Array {
  assertKeeperCommitmentShape(value);
  const writer = new CanonicalWriter();
  writer.hex(value.designationHash);
  writer.u8(value.branch === 'yes' ? 0 : 1);
  writer.hex(value.secretHash);
  return writer.finish();
}

/** Derive the lowercase SHA-256 keeper commitment identifier. */
export function hashKeeperCommitment(value: CourtKeeperCommitment): string {
  return digestDomain(COURT_KEEPER_COMMITMENT_DOMAIN, encodeKeeperCommitment(value));
}

/**
 * Assert that a published keeper commitment matches a designation: the
 * designation hash must bind to this exact designation and the committed
 * secret hash must equal the designation's commitment for that branch.
 */
export function assertKeeperCommitmentForDesignation(params: {
  readonly designation: CourtKeeperDesignation;
  readonly commitment: CourtKeeperCommitment;
}): void {
  assertKeeperDesignationShape(params.designation);
  assertKeeperCommitmentShape(params.commitment);
  if (params.commitment.designationHash !== hashKeeperDesignation(params.designation)) {
    throw new CourtKeeperError(
      'commitment_mismatch',
      'keeper commitment binds to a different designation',
    );
  }
  const expected =
    params.commitment.branch === 'yes'
      ? params.designation.yesCommitment
      : params.designation.noCommitment;
  if (params.commitment.secretHash !== expected) {
    throw new CourtKeeperError(
      'commitment_mismatch',
      `keeper commitment does not match the designation's ${params.commitment.branch}-branch commitment`,
    );
  }
}

/** SHA-256 of a 32-byte keeper secret given as lowercase hex. */
export function hashKeeperSecret(secret: string): string {
  assertHex32(secret, 'secret');
  return bytesToHex(sha256(hexToBytes(secret)));
}

/**
 * Verify a keeper reveal against its published commitment. The reveal must
 * name the same branch as the commitment ('wrong_branch' otherwise) and
 * SHA-256 of the 32-byte secret bytes must equal the committed hash
 * ('reveal_mismatch' otherwise). Returns true on success; never returns
 * false — failures throw CourtKeeperError.
 */
export function verifyKeeperReveal(params: {
  readonly commitment: CourtKeeperCommitment;
  readonly secret: string;
  readonly branch: CourtKeeperBranch;
}): true {
  assertKeeperCommitmentShape(params.commitment);
  assertBranch(params.branch, 'branch');
  if (params.branch !== params.commitment.branch) {
    throw new CourtKeeperError(
      'wrong_branch',
      `reveal for branch '${params.branch}' cannot satisfy a '${params.commitment.branch}' commitment`,
    );
  }
  assertHex32(params.secret, 'secret');
  if (hashKeeperSecret(params.secret) !== params.commitment.secretHash) {
    throw new CourtKeeperError(
      'reveal_mismatch',
      'keeper reveal does not match the committed secret hash',
    );
  }
  return true;
}
