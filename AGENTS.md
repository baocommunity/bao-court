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
2. **Tag every release in the same push, and create the GitHub Release.**
   This package ships by git ref/tag — it is NOT published to npm. After a
   version bump: `git tag -a vX.Y.Z -m "..." && git push origin main vX.Y.Z`
   in ONE action, then `gh release create vX.Y.Z --title "vX.Y.Z — <one-line>"
   --notes-file <changelog-section>` in the SAME session. A tag without a
   Release object is invisible on the Releases page (the 2026-11-10 incident:
   tags through v0.10.2 existed while the page still showed v0.7.1 — 13
   releases back-filled). Current: **v0.10.2** (API-surface JSDoc, glossary,
   presentation kit, proofs, security definitions, economics theorems — the
   full v0.8.0→v0.10.2 arc is in `CHANGELOG.md`).
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

## Public site — court.bao.network

- `site/index.html` is the public paper-edition landing (static, no build
  step). It is protocol-accurate copy only — this repo is public: no
  internal hosts, credentials, or private rail details.
- `.github/workflows/pages.yml` deploys `site/` to GitHub Pages on pushes to
  `main` touching it (`workflow_dispatch` enabled). The Pages custom domain
  is `court.bao.network`, HTTPS enforced; GitHub provisions/renews the cert
  (keep the DNS record DNS-only so renewal works).
- `.github/workflows/check-live-site.yml` compares the live documents and
  assets (`/llms.txt`, `/llms.md`, `/.well-known/llms.txt`, `/robots.txt`,
  `/sitemap.xml`, `/.well-known/security.txt`, `/og.png`, `/icon-512.png`,
  `/apple-touch-icon.png`, `/favicon-32.png`, `/favicon.ico`) to `site/` every
  six hours and on manual dispatch, and fails naming the path that drifted —
  bytes AND content type, binaries included. Run
  `node scripts/check-live-site.mjs` locally to check now. The check skips
  `index.html` and `404.html`: Cloudflare rewrites HTML in flight (body anchor,
  `__cf_email__` obfuscation), so a byte comparison there would fail on a
  perfectly current deployment; what those two files claim is asserted
  structurally in `__tests__/siteDiscovery.test.ts` instead.
- The same page is mirrored into the public `baocommunity/bao.network` repo
  by its scheduled `mirror-court.yml` workflow and renders at
  `https://bao.network/court/`. Edit it HERE only; the mirror copies
  `site/index.html` byte-for-byte.
- **Discovery invariants (measured 2026-11-17, `docs/DISCOVERY_AUDIT.md`).**
  This host exists to be found by a machine, so the head and the crawl files
  are part of the contract, not decoration:
  1. `<link rel="canonical" href="https://court.bao.network/">` and a matching
     `og:url` **with the trailing slash** — `/` and `/index.html` both answer
     200 with no redirect, and the `bao.network/court/` mirror serves the same
     bytes, so four URLs compete for one document without the tag.
  2. `og:image` / `twitter:image` must stay **absolute** and point at
     `site/og.png` (1200×630). `twitter:card` is `summary_large_image`; a card
     type with no image renders text-only.
  3. `sitemap.xml`, `/.well-known/security.txt` and `404.html` ship from
     `site/`; `robots.txt` keeps its `Sitemap:` pointer and the discovery
     `Allow` carve-outs. `security.txt`'s `Expires` is asserted by the suite —
     renew it rather than deleting the assertion.
  4. The three copies of the brief (`llms.txt`, `llms.md`,
     `/.well-known/llms.txt`) are **byte-identical** (asserted). Never put a
     version number in the brief: it read v0.7.2 while the package was 0.17.2.
  5. `bao.network` is the **legacy** network host — it still serves, but label
     it as legacy in machine-facing documents; `court.bao.network` is canonical.
  6. Keep the icon paths: `favicon.ico`, `favicon-32.png`,
     `apple-touch-icon.png` exist because browsers and agents fetch the
     conventional paths without parsing the head, and a miss costs a 9.4 KB
     error page.
  Verify: `node scripts/check-live-site.mjs` and
  `npx vitest run __tests__/siteDiscovery.test.ts`.
- **Accessibility invariants (measured, round 2 of the GUI red-team).** Keep
  them if you touch the page: exactly one `<main>` (the skip-link target,
  `id="main"`, `tabindex="-1"`), one `<h1>` (the nameplate) with no heading
  level skips, a `.skip-link` as the first focusable element, and no text
  below 4.5:1 or target below 24×24 px at 390 px wide. `--np-accent` is a
  3.60:1 text colour on the `.note` tint — use `--np-accent-ink` for text on
  that panel and `--np-accent` for rules, borders and fills. The footer link
  row carries 44 px hit boxes via `min-height` (2.5.5); the rest of the footer
  rhythm is unchanged. Verify from the `bao.markets` checkout:
  `node scripts/gui-redteam/depth2/run.mjs --checks axe,keyboard,touch`.
- **Performance invariants (measured, round 5 of the GUI red-team).** CLS must
  stay ≤ 0.1 and the hero CTAs ≥ 44 px at 390 px wide. Two things make that
  hold and must not be undone:
  1. **`#folio-date` is written during parse**, from the small script between
     `</header>`/`</nav>` and `<main>` — never from the page script at the end
     of the body. The folio is a wrapping flex row, so the one-word placeholder
     laid out one row, and replacing it with the three-word date late grew the
     masthead by 23 px and pushed `main` down by the same amount (CLS 0.1671 at
     402 ms). Writing it during parse makes the first layout the settled one at
     every width (the row is three lines ≤ 420 px, two at 430–600, one from
     640 px — a `min-height` reservation cannot be right everywhere).
  2. **`.lead .btn` / `.cta-row .btn` carry a 44 px `min-height` inside
     `@media (pointer: coarse), (max-width: 40rem)`** — `min-height`, never a
     bigger font, and scoped so the compact support-panel buttons keep their
     24 px sizing. Desktop keeps the 36 px box exactly (all boxes at 1440×900
     are identical before/after).

  The measurement, the before/after table and the two-command repro are in
  [`docs/SITE_ROUND5_PERFORMANCE.md`](docs/SITE_ROUND5_PERFORMANCE.md); the
  harness lives in `bao.markets/scripts/gui-redteam/round5/`.
- **Delivery invariants (measured 2026-11-17, `docs/SITE_DELIVERY_AUDIT.md`).**
  This host is the one BAO surface that stayed reachable while `bao.markets`
  was answering 429, so its delivery is part of the contract:
  1. **Content first.** Every `<script>` belongs *after* `</main>` and
     `</footer>`; the only script allowed inside the content path is the
     `#folio-date` one-liner between `</header>` and `<main>`, which exists to
     kill CLS. The 90.6 kB of vendored `@noble/*` + NWC + `node-qrcode` must
     never move above `<main>` — with script off or blocked, the page must
     still be the page (8,964 of 8,987 characters, every link live).
  2. **No subresources.** 0 `<script src>`, 0 stylesheet `<link>`, 0 `<img>`,
     0 `@font-face`. That is *why* there is nothing to preload and nothing to
     put SRI on, and why a first load is 2 requests. A third-party asset is a
     decision, not an edit: it needs `integrity` and a paragraph here.
  3. **Headers are the edge's job.** GitHub Pages sets `cache-control`
     (600 s HTML, 4 h assets) and no file in this repo can change it —
     `_headers`, `netlify.toml` and `<meta http-equiv>` are all ignored for
     caching. Cache and serve-stale rules, plus what is still open, are in
     `docs/SITE_DELIVERY_AUDIT.md` §7. The HTML is *not* cached at the
     Cloudflare edge today (`cf-cache-status: DYNAMIC`), which is why a Pages
     outage takes the page down.
  4. **The no-JS contract.** With JavaScript off exactly two things differ: the
     folio date reads `Today`, and Cloudflare's email obfuscation leaves
     `[email protected]`. Accepting a third difference needs a doc update.
  Verify: `node scripts/site-delivery-audit.mjs` (HTTP half, 1 req/s, fails on
  regressions only) and the browser checks in `docs/SITE_DELIVERY_AUDIT.md` §2.

## Verify before tagging

```bash
npm test                 # vitest — green (v0.6.x: 659 passing, 1 env-gated live test skipped)
npm run typecheck        # tsc --noEmit
npm run typecheck:scripts
npm run simulate:court   # end-to-end whole-court deterministic sim (needs tsx)
```

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`baocommunity/bao-court`, `gh` CLI). See
`docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root + `docs/adr/`. See
`docs/agents/domain.md`.
