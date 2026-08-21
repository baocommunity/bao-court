# appealCoordinator stays a mutable driver; ceremony machines are the frozen core

Status: accepted (2026-08-21, architecture review)

The three protocol ceremony machines (DKG, voting, signing) are the frozen,
audited core: pure reducers, deep-frozen state, fail-closed invariants. The
`appealCoordinator` is a single-process demo/integration driver that
orchestrates those machines; converting it into a fourth ceremony machine was
considered during the 2026-08-21 architecture review (candidate #4, rated
Speculative) and rejected.

Why: the coordinator's phase bookkeeping and mutable maps are the JIT appeal
pipeline's integration surface, which is expected to keep changing as the
pipeline evolves in bao.markets. The ceremony machines' reducer pattern pays
off where the transition set is frozen and audited; the coordinator's is not.
Future architecture reviews should not re-suggest this conversion while the
coordinator's shape is still moving — revisit only if the JIT pipeline
stabilizes as protocol.
