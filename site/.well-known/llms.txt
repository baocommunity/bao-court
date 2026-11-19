# ₿AO Court

> A FROST threshold oracle for dispute resolution: a randomly selected jury runs DKG, votes under commit/reveal, and signs a verifiable threshold Schnorr verdict. It decides — it never holds funds.

Served at https://court.bao.network and mirrored at https://bao.network/court/ (the legacy network host; court.bao.network is canonical). The protocol source of truth is the public repository `baocommunity/bao-court`; this page is its landing.

## Start here
If you read nothing else, read these five.

- [FROST court oracle paper](https://bao.markets/FROST_COURT_ORACLE_PAPER.md) — the full design: empanelment, DKG, commit/reveal voting and threshold verdicts.
- [Protocol repository](https://github.com/baocommunity/bao-court) — canonical code and release tags, AGPL-licensed. The newest tag on `https://github.com/baocommunity/bao-court/tags` is the released version; this brief deliberately names no version number, because a number here goes stale silently.
- [Signing and verification](https://raw.githubusercontent.com/baocommunity/bao-court/main/SIGNING.md) — how court artifacts are signed and how to verify them.
- [Settlement rails](https://bao.markets/SETTLEMENT-RAILS.md) — how a verdict settles value on Lightning and Liquid.
- [Network agent brief](https://bao.markets/llms.txt) — the network-wide agent contract (legacy copy: `https://bao.network/agent/onboarding.md`); the court is one of the money-adjacent surfaces it describes.

## What the court is
- It decides; it never holds funds. A verdict is a signed statement — moving value is the job of each app's escrow adapter.
- The jury is randomly selected per dispute, runs DKG, then votes commit/reveal so no early vote leaks.
- A verdict is a threshold Schnorr signature verifiable against a pinned group key; no single operator can settle a new escrow.
- Appeals and settlement execution are app-agnostic: `bao.fund` and `bao.markets` supply their own escrow adapters.

## The court API (what an agent can call)
The court is reachable as part of the BAO Markets API — Public Testnet is
`https://api-testnet.bao.markets/v1`. Two machine-readable surfaces describe it,
and both are generated from the code, so if either disagrees with a route the
route is right and the document is stale:

- `GET /v1/openapi.json` — every operation, court routes tagged `Court` (agent-facing) or `Admin` (operator-only), each carrying the `nostrAuth` / `apiKey` requirement the route enforces.
- `GET /v1/agent/manifest` → `discovery.court_*` — the prose contract, including the body an escalation must carry.

Public reads (no auth): `GET /v1/court/liquid-lock` (the Liquid bond address; add `?pubkey=<64-hex x-only>` for the juror-bound seat lock), `GET /v1/court/dispute-stats`, `GET /v1/markets/:marketId/disputes`.

The two critical writes are the same route one boolean apart. NIP-98 (or an API key) is required, and **auth is checked before the body schema**, so an anonymous `{}` is `401 AUTH_MISSING`, never a schema error:

- `POST /v1/court/cases/:caseId/escalate` — open the next ladder rung (a bonded challenger's signed request).
- the same route with `{"concession": true}` — drop the appeal.

`GET /v1/court/cases/:caseId/escalations` is the transport trail: accepted **and rejected** requests, each re-verified on read. `503 COURT_ESCALATION_DISABLED` is the expected answer on Public Testnet — the ladder is enabled per deployment, so `401 → 400 (typed, naming the missing field) → 503` is the documented sequence there.

Jurors do not use the agent key. Jury duty is humans on the court UI, and the juror's software is the published kit: `https://bao.markets/agent/juror-kit-0.2.1.tgz` (+ `.sha256`), pinned to the current protocol release. Court traffic rides the testnet relay `wss://relay-testnet.bao.markets` (court kinds 38025/38026/38031/39001/39002/39004/39005/39006/39007/39008/39014/39015/39018, each event carrying its `n=testnet` network tag). Deliveries are sealed: private traffic is kind-1059 gift wraps, and a summons is acknowledged with a signed kind-39008 ack.

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

- [The ₿AO hub](https://bao.network/) — network overview and the network-wide [agent brief](https://bao.network/agent/onboarding.md). This is the legacy host: it still serves, but nothing here depends on it staying registered — the court's canonical home is court.bao.network.
- [BAO Markets](https://bao.markets/) — prediction markets and the court API above; [testnet API reference](https://api-testnet.bao.markets/v1/openapi.json) and [LLM bot guide](https://bao.markets/devkit/llm.html).
- [₿AO Fund](https://bao.fund/) — milestone fundraising; the [live campaign list](https://app.bao.network/fund-api/v1/fundraisers).
- [₿AO₿AO](https://bao.bao.network/), [2140 Social](https://2140.social/) and [2140.wtf](https://2140.wtf/) — the Nostr clients.
- Relays: demo `wss://relay.bao.markets`, testnet `wss://relay-testnet.bao.markets`; community chat runs on `wss://relay.bao.fund`.

## Optional
- [Prototype compromises](https://bao.markets/PROTOTYPE_COMPROMISES.md) — what the FROST prototype is explicitly not safe for.
- [Served copy of the paper](https://bao.markets/FROST_COURT_ORACLE_PAPER.md) — the same paper from the markets host.
