# AGENTS.md — bao-court (canonical BAO Court protocol package)

## You are in the CANONICAL repo

`baocommunity/bao-court` (public) is the **single source of truth** for all
BAO Court protocol code: FROST threshold-oracle math, state machines (DKG,
selection, commit/reveal voting, signing), the JIT appeal pipeline
(`appealCoordinator.ts` / `appealWatcher.ts` / `appealTiming.ts`),
settlement-rail contracts + fakes (LN hold invoices, Liquid P2WSH/Taproot
escrow), and the protocol paper (`docs/FROST_COURT_ORACLE_PAPER.md`).

## Hard rules

1. **All protocol changes happen HERE first.** Never edit the vendored copy
   in bao.markets (`packages/lib/frost-court`) directly — it is a byte-exact
   mirror synced FROM this repo. Edits made there are overwritten on the
   next sync.
2. **Tag every release in the same push.** This package ships by git
   ref/tag — it is NOT published to npm. After a version bump:
   `git tag -a vX.Y.Z -m "..." && git push origin main vX.Y.Z` in ONE
   action. Current: **v0.4.0** (`f5eacae`).
3. **Versioning:** bug fixes → patch (`0.4.1`); new modules/capabilities or
   consumer-visible API changes → minor (`0.5.0`). 1.0.0 stays reserved
   until the trusted-dealer DKG is replaced with production Pedersen DKG
   and the API is frozen.
4. **IP boundary (this repo is PUBLIC).** Here: protocol math, state
   machines, adapter contracts (`FrostRelayPool`, `LnRail`, `LiquidRail`),
   fakes, the paper. PRIVATE in bao.markets only: rail execution against
   real nodes, node credentials, market settlement-contract builders
   (`frost/payout.ts`), business policy. Never commit credentials, internal
   hosts/IPs, or market-specific payout logic here.
5. **Host-injected everything.** No networking, storage, or clock of its
   own — hosts inject transport/storage/clock. The library stays
   platform-neutral (browser + Node).
6. **package.json stays vendor-safe.** The bao.markets copy is consumed via
   `file:./packages/lib/frost-court` and validated by `npm ci`. The sync
   strips devDependencies/scripts; do not add runtime deps that consumers
   can't resolve, and keep the published surface backward-compatible within
   a minor line.

## After merging a protocol change: vendor-sync into bao.markets

1. Tag + push here (rule 2).
2. In bao.markets: worktree from `origin/main`, rsync this repo's impl
   files over `packages/lib/frost-court/`, keep the name `@bao/frost-court`,
   mirror the version metadata, strip devDeps/scripts from the vendored
   package.json, verify byte-parity of impl files, run the in-tree suite,
   PR → merge (main is branch-protected).
3. Update the machine notes (`/home/bob/AGENTS.md`) with the new version.

## Verify before tagging

```bash
npm test                 # vitest — 582/582 green at v0.4.0
npm run typecheck        # tsc --noEmit
npm run typecheck:scripts
npm run simulate:court   # end-to-end whole-court deterministic sim (needs tsx)
```
