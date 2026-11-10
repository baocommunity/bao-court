// Shared test helpers for the BAO Court suite. See docs/TESTING_GUIDE.md.
//
//   rng.ts       — ONE seeded generator (mulberry32) + labeled child streams
//   ids.ts       — deterministic hex-id factories
//   keys.ts      — schnorr/host keypair fixtures (deterministic = jsdom-safe)
//   machines.ts  — create+drive helpers for the three ceremony machines
//   fixtures.ts  — committed-fixture readers (model-check) + V2 attestation builder
//   asserts.ts   — typed-error / freeze-discipline / monotonic-clock asserts
export { mulberry32, childRng, int, pick, hex32, uniqueHex32, secFrom } from './rng';
export { hexId, padHexId, repeatHexId, byteHexId } from './ids';
export { seckey, nostrPubkey, hostPubkey, schnorrKeypair, schnorrKeypairHex } from './keys';
export {
  voteMachine, voteCommitEvent, voteRevealEvent, voteToRevealsOpen, voteClosedReveals,
  confirmationMachine, confirmHashFor, confirmationAcceptEvent, confirmationAt,
  confirmHappyPath, confirmChallengedTo, massVote, drive,
  signingMachine, dkgMachine,
  VOTE_DEFAULTS, VOTE_SALT, CONFIRM_DEFAULTS,
} from './machines';
export { loadModelCheckSummary, buildV2AttestationEvent, juror, jurorWithKeys, type V2Fields } from './fixtures';
export {
  expectTypedOrOk, captureError, assertDeeplyFrozen, assertConfirmationStateFrozen, assertClockMonotonic,
} from './asserts';
