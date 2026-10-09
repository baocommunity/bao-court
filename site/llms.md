# ₿AO Court

> A FROST threshold oracle for dispute resolution: a randomly selected jury runs DKG, votes under commit/reveal, and signs a verifiable threshold Schnorr verdict. It decides — it never holds funds.

Served at https://court.bao.network and mirrored at https://bao.network/court/. The protocol source of truth is the public repository `baocommunity/bao-court`; this page is its landing.

## Start here
If you read nothing else, read these five.

- [FROST court oracle paper](https://bao.markets/FROST_COURT_ORACLE_PAPER.md) — the full design: empanelment, DKG, commit/reveal voting and threshold verdicts.
- [Protocol repository](https://github.com/baocommunity/bao-court) — canonical code and release tags (v0.7.2 at the time of writing), AGPL-licensed.
- [Signing and verification](https://raw.githubusercontent.com/baocommunity/bao-court/main/SIGNING.md) — how court artifacts are signed and how to verify them.
- [Settlement rails](https://bao.markets/SETTLEMENT-RAILS.md) — how a verdict settles value on Lightning and Liquid.
- [Agent onboarding brief](https://bao.network/agent/onboarding.md) — the network-wide agent contract; the court is one of the money-adjacent surfaces it describes.

## What the court is
- It decides; it never holds funds. A verdict is a signed statement — moving value is the job of each app's escrow adapter.
- The jury is randomly selected per dispute, runs DKG, then votes commit/reveal so no early vote leaks.
- A verdict is a threshold Schnorr signature verifiable against a pinned group key; no single operator can settle a new escrow.
- Appeals and settlement execution are app-agnostic: `bao.fund` and `bao.markets` supply their own escrow adapters.

## Protocol reference
- [README](https://raw.githubusercontent.com/baocommunity/bao-court/main/README.md) — what the package is and how it is consumed.
- [CHANGELOG](https://raw.githubusercontent.com/baocommunity/bao-court/main/CHANGELOG.md) — release history, newest first.
- [CONTEXT](https://raw.githubusercontent.com/baocommunity/bao-court/main/CONTEXT.md) — architecture context and driving requirements.
- [Complaint protocol](https://raw.githubusercontent.com/baocommunity/bao-court/main/docs/COMPLAINT-PROTOCOL.md) — how a dispute is filed and admitted.
- [Escrow slashing](https://raw.githubusercontent.com/baocommunity/bao-court/main/docs/ESCROW-SLASHING.md) — bond and slashing rules.
- [Architecture decisions](https://github.com/baocommunity/bao-court/tree/main/docs/adr) — the ADR log.
- [Repo agent rules](https://raw.githubusercontent.com/baocommunity/bao-court/main/AGENTS.md) — hard rules for changing protocol code.

## The court in the ₿AO network
Every one of these hosts publishes its own `/llms.txt` and its own robots policy.

- [The ₿AO hub](https://bao.network/) — network overview and the canonical [agent brief](https://bao.network/agent/onboarding.md).
- [BAO Markets](https://bao.markets/) — prediction markets; [demo API reference](https://bao.markets/devkit/api.html) and [LLM bot guide](https://bao.markets/devkit/llm.html).
- [₿AO Fund](https://bao.fund/) — milestone fundraising; the [live campaign list](https://app.bao.network/fund-api/v1/fundraisers).
- [₿AO₿AO](https://bao.bao.network/), [2140 Social](https://2140.social/) and [2140.wtf](https://2140.wtf/) — the Nostr clients.
- [Demo relay](https://relay.bao.network/) and [testnet relay](https://relay.testnet.bao.network/); community chat runs on `wss://relay.bao.fund`.

## Optional
- [Prototype compromises](https://bao.markets/PROTOTYPE_COMPROMISES.md) — what the FROST prototype is explicitly not safe for.
- [Served copy of the paper](https://bao.markets/FROST_COURT_ORACLE_PAPER.md) — the same paper from the markets host.
