# bao-court

Canonical BAO Court protocol package: FROST threshold-oracle math, ceremony
state machines, the JIT appeal pipeline, and settlement-rail contracts. This
glossary gives names to the domain concepts so code, docs, and reviews share
one language.

## Language

**Ceremony**: One protocol run with a fixed roster and deadline — a DKG
attempt, a commit/reveal vote, or a FROST signing attempt. Ceremonies are pure
state machines (`courtDkgMachine`, `courtVoteMachine`, `courtSigningMachine`).
_Avoid_: session, round (a phase within a ceremony, not the ceremony).

**Ceremony machine**: A pure fail-closed reducer over a frozen state
(`create` + `reduce` + exported error/state/event types). The public surface
of the three ceremony machines is frozen and consumer-visible.
_Avoid_: state machine (ambiguous), service.

**Ceremony core**: The internal shared module (`courtCeremonyCore.ts`) holding
the invariants every ceremony machine implements — roster assertion, deadline
enforcement, phase sets, blame validation, caps. Machines keep only
ceremony-specific ledgers.
_Avoid_: utilities, helpers.

**Roster**: The certified participant indices of a ceremony, exactly the
sequential integers 1..n, capped. Every ceremony message names a roster member.
_Avoid_: participants, members, signers (a signing-roster member).

**Juror**: A human or agent holding one roster index in a ceremony.
_Avoid_: signer, participant, node.

**Vote commit / vote reveal**: The two phases of the voting ceremony. A commit
binds a juror to a salted outcome hash under the session; a reveal publishes
outcome + salt and must match the juror's commit.
_Avoid_: ballot, ballot hash.

**Verdict**: The tally winner of a voting ceremony — the ONLY outcome the
signing ceremony may attest. Carries a dispute verdict hash bound to the
dispute, outcome, and supporting reveal event ids.
_Avoid_: result, outcome (the attested string; the verdict is the decision).

**Attestation**: The signed FROST outcome of a signing ceremony (kind 39007
for disputes, kind 89 for markets), publicly verifiable against the group
pubkey and the verdict commitment.
_Avoid_: certificate, signature (one attestation field, not the whole).

**Gift wrap**: A NIP-59 private message — a rumor sealed (kind 13) and wrapped
(kind 1059) to a recipient. Unwrapping is strict: every layer verifies or the
message is dropped.
_Avoid_: envelope, wrap (noun form: gift wrap).

**Rumor**: The inner NIP-59 event that carries the actual protocol message.
_Avoid_: message (ambiguous with coordinator emissions).

**Seal**: The NIP-59 middle layer, signed by the rumor's author, binding
rumor authorship.
_Avoid_: wrapper.

**Unwrap core**: The shared filter/dedup module (`courtUnwrapCore.ts`) behind
the two unwrap adapters — seckey-backed (`nip59.ts`) and signer-backed
(`courtSigner.ts`).
_Avoid_: unwrap helper, parser.

**Appeal**: A disputed market escalated to the JIT FROST appeal pipeline,
coordinated by the appeal coordinator (a mutable driver, not a ceremony
machine — see ADR-0001).
_Avoid_: case, dispute (the on-chain dispute event the appeal responds to).
