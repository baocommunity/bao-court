# Discovery & SEO audit — court.bao.network

**Date:** 2026-11-17 · **Host:** `https://court.bao.network/` (GitHub Pages
origin, Cloudflare in front) · **Scope:** machine-discoverability of a host whose
only purpose is to be found, read and cited by agents and people.

Method: read-only `curl`/browser probes against production at ≤ 1 req/s, plus a
source audit of `site/`. Deployed bytes were confirmed to be this checkout's
`site/index.html` (`diff` reduces to two Cloudflare rewrites: a hidden
bot-management anchor and the `__cf_email__` obfuscation). Every finding below
has a repro you can paste. **All 7 findings and 6 of 8 weak points are fixed in
this change**; the two that are not need the edge (Cloudflare) or another host,
and are documented as such.

Counts: **24 PASS · 8 WEAK · 7 FINDING** across 39 checks (one row is split:
`/nonexistent` was a correct 404 status with a useless body).

---

## 1. Per-item table

Legend — **PASS** meets the requirement; **WEAK** works but is fragile, thin or
inconsistent; **FINDING** broken for a machine consumer.

### 1.1 Meta / social

| # | Item | State | Evidence / fix |
|---|---|---|---|
| 1 | `<title>` | **PASS** | `₿AO Court - Threshold Oracle for Dispute Resolution` (51 chars). Unchanged. |
| 2 | `description` | **PASS** | 172 chars, present in `site/index.html`. |
| 3 | `<link rel="canonical">` | **FINDING → fixed** | Absent. Four URLs served the same bytes: `/`, `/index.html` (**200, no redirect**), the `*.github.io` origin, and the `bao.network/court/` mirror. Added `href="https://court.bao.network/"`. |
| 4 | `og:url` | **FINDING → fixed** | Was `https://court.bao.network` — no trailing slash, so it did not equal the served URL. Now `https://court.bao.network/`, identical to the canonical. |
| 5 | `og:title` / `og:description` / `og:type` / `og:site_name` | **PASS** | All present and absolute-free (correct — they are text). |
| 6 | `og:image`, `twitter:image` | **FINDING → fixed** | `twitter:card` said `summary_large_image` with **no image anywhere** — every share rendered a text-only card. Added `site/og.png` (1200×630, 63.9 KB, the masthead itself) on both tags with `og:image:type/width/height/alt` and `twitter:image:alt`. |
| 7 | `twitter:card` | **WEAK → fixed** | Was `summary_large_image` with nothing to show (see #6); now backed by a real 1200×630 image. |
| 8 | `theme-color` | **WEAK → fixed** | Absent. Added `#f4f1ea` (the page background), also on `404.html`. |
| 9 | `lang` | **PASS** | `<html lang="en">`. |
| 10 | `rel="alternate" type="text/markdown"` → `/llms.txt` | **PASS** | Present, root-relative (correct: each host advertises its own brief). |

Repro for the original failures:

```bash
curl -sS https://court.bao.network/ | grep -cE 'rel="canonical"|og:image|theme-color'
# 0
curl -sS -o /dev/null -w '%{http_code}\n' https://court.bao.network/index.html
# 200  (a second, non-redirecting URL for the same document)
```

### 1.2 Structured data

| # | Item | State | Evidence / fix |
|---|---|---|---|
| 11 | JSON-LD | **FINDING → fixed** | Zero `application/ld+json`. Added one `@graph` with `WebSite` + `Organization` (`@id` cross-referenced so it stays one graph), `inLanguage: en`, `publisher`, `logo`, `sameAs` → the repo. |

**Worth it for an agent-facing page?** Partly. Agents read `llms.txt` and the
HTML; JSON-LD is consumed by search engines and social unfurlers, so its value
here is discoverability *around* the page (knowledge panel, sitelinks, richer
unfurl), not comprehension. It costs ~1 KB in an already-inline head and cannot
go stale the way prose does, so it is carried.

**Deliberately not `Article`.** The proposal in the brief was
`Organization`/`WebSite` + `Article` for the paper link. `Article` was rejected:
this URL is a *landing page*, not a copy of the paper — the paper is a separate
document in the repository (`docs/FROST_COURT_ORACLE_PAPER.md`, also served from
`bao.markets`). Marking the landing as an `Article` would assert a duplicate
that does not exist, and a `mainEntityOfPage` pointing at GitHub would be worse.

### 1.3 Crawl files

| # | Item | State | Evidence / fix |
|---|---|---|---|
| 12 | `robots.txt` is repo-owned | **PASS** | Live bytes are byte-identical to `site/robots.txt` (`sha256 4ed36a8c…`, 3088 B), `text/plain; charset=utf-8`, `ETag W/"6afc6c4f-c10"`, conditional GET → 304. |
| 13 | `sitemap.xml` | **FINDING → fixed** | `/sitemap.xml` → **404** (GitHub Pages' generic card). Added `site/sitemap.xml` (one `<loc>`: `/` — the only HTML document on the host) and a `Sitemap:` line in `robots.txt`. |
| 14 | `llms.txt` reachable + type | **PASS** | 200, `text/plain; charset=utf-8`, 3.8 KB. |
| 15 | `llms.md` reachable + type | **PASS** | 200, `text/markdown; charset=utf-8`. |
| 16 | `/.well-known/llms.txt` reachable + type | **PASS** | 200, `text/plain; charset=utf-8`. |
| 17 | the three briefs agree | **PASS** | Byte-identical: `sha256 b5d508d0…` for all three before this change, `3c83af77…` after (all three updated together — now asserted by a test). |
| 18 | `/.well-known/security.txt` | **FINDING → fixed** | 404. Added with `Contact` (the repo's private advisory form — `SECURITY.md` asks reporters not to use a public channel and publishes no mailbox), `Expires: 2027-05-17`, `Canonical`, `Policy`, `Preferred-Languages`. |
| 19 | `favicon.ico` | **WEAK → fixed** | 404 — the page shipped only a `data:` SVG icon, so every browser and every agent probing the conventional path paid a 9.4 KB error page. Added a real `favicon.ico` (32×32 PNG in an ICO shell), `favicon-32.png` and an opaque `apple-touch-icon.png` (180×180); the `data:` SVG stays first for crispness. |
| 20 | `llms.txt` accuracy | **WEAK → fixed** | It claimed "release tags (v0.7.2 at the time of writing)"; `package.json` was **0.17.2** — ten minor versions stale in the one document agents read first. The version number is gone (it cannot go stale silently again); a test forbids a bare `vX.Y.Z` there. |
| 21 | every link in `llms.txt` resolves | **WEAK — external, documented** | `bao.markets` returns **429** to this host today (edge block 1027) — including the first "Start here" link and two "Optional" links. Not our host and not our fix: the same paper is linked from the repo. All other brief links verified 200, including `bao.network/agent/onboarding.md` (10.7 KB `text/markdown`). |

```bash
# original failures
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://court.bao.network/sitemap.xml
# 404 text/html
curl -sS -o /dev/null -w '%{http_code}\n' https://court.bao.network/.well-known/security.txt
# 404
curl -sS -o /dev/null -w '%{http_code}\n' https://court.bao.network/favicon.ico
# 404
```

### 1.4 Status / redirects

| # | Item | State | Evidence |
|---|---|---|---|
| 22 | `/nonexistent` | **PASS** (status) / **FINDING** (content) | Real 404 (`HTTP/2 404`, `text/html`, no redirect loop). But the body was GitHub's generic card: no nameplate, no way home, no `noindex`. See #23. |
| 23 | 404 page usefulness | **FINDING → fixed** | Added `site/404.html` (GitHub Pages serves it for any miss): the masthead, `robots: noindex`, a 44 px "Back to the front page" link, `llms.txt`, and the list of the six addresses this host serves. No script, no image, no font — 5.4 KB, one request. Verified with axe: 0 violations. |
| 24 | `http://` → `https://` | **PASS** | Single `301` with `Location: https://court.bao.network/`; no chain (`num_redirects=0` followed). |
| 25 | Trailing slash | **PASS** | `/llms.txt/` → 404, no loop, no silent 200. |
| 26 | Case variant | **WEAK — documented** | `/LLMS.txt` → **404** (GitHub Pages is case-sensitive on Linux). Sane, but an agent that title-cases a URL fails hard. A normalising 301 would have to come from the edge; not worth an edge rule. |
| 27 | HEAD vs GET | **PASS** | Same status, `content-type`, `ETag`, `last-modified`; conditional GET → `304`. |

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://court.bao.network/nonexistent-page-xyz
# 404 text/html   (body: "Page not found · GitHub Pages")
curl -sSL -o /dev/null -w '%{http_code} %{url_effective} %{num_redirects}\n' http://court.bao.network/
# 200 https://court.bao.network/ 1
```

### 1.5 Content

| # | Item | State | Evidence |
|---|---|---|---|
| 28 | exactly one `<h1>` | **PASS** | One, on the nameplate (`₿AO COURT`). Already locked by `__tests__/siteLanding.test.ts`. |
| 29 | heading outline | **PASS** | `h1 → h2 → h3…`, no level skips (33 headings). |
| 30 | link targets | **PASS** | Every `href` is an absolute `https://` URL or an in-page fragment; no root-relative anchors to break under the mirror. The head's root-relative discovery links (`/llms.txt`, the icons) all resolve to files in `site/` — now asserted. |
| 31 | `rel="noopener"` on new tabs | **PASS** | 6/6 `target="_blank"` anchors carry it (now asserted). |
| 32 | dead hosts | **PASS** | Every external host resolves today: `bao.markets` 200, `bao.network` 200, `bao.bao.network` 200 (`₿AO₿AO`, a real Nostr client — not a typo for `bao.network`), `fund.bao.network` 200, `github.com`. |
| 33 | legacy host labelled | **WEAK → fixed (brief) / documented (page)** | `llms.txt` called `bao.network` "the canonical hub" and the court's mirror target; it is now labelled the **legacy network host** (it still serves; it is not being renewed). The visible nav/CTA and footer keep pointing at it — it is live and is the network hub today — so the machine-facing correction is the label plus the new canonical tag, not a rewrite of human copy. |
| 34 | `href="#"` placeholder | **WEAK → fixed** | One anchor (`#zap-open`) shipped `href="#"` as a placeholder, replaced with a `lightning:` URI on invoice creation. It stays an anchor (the target really is a `lightning:` deep link), the placeholder is now documented, and the URI is assigned **before** the element is unhidden so the `#` is never the live target. |

### 1.6 Performance / weight

| # | Item | State | Measured |
|---|---|---|---|
| 35 | total transfer | **PASS** | **50.2 KB brotli** for the document (`content-encoding: br`; 148.8 KB decoded) + 0.96 KB for the injected email-decode script = **51.2 KB total**. |
| 36 | requests on first load | **PASS** | **2**: the document, plus Cloudflare's injected `email-decode.min.js` (961 B) — the page itself requests nothing. |
| 37 | images / fonts / JS files | **PASS** | 0 images, 0 `@font-face`, 0 external stylesheets, 0 external `<script src>`. Everything is inline: CSS 18.9 KB, JS 125.5 KB. |
| 38 | render-blocking | **PASS** | No `<link rel="stylesheet">` and no head script. The 125.5 KB of inline JS (vendored `@noble/*`, NWC client, `qrcode`) parses **after `</main>`**, so it cannot delay the visible page: DCL 267 ms, load 268 ms measured. |
| 39 | fonts | **PASS / WEAK** | `Newsreader` and `JetBrains Mono` are named but never fetched (CSP `font-src 'self'` and the single-file design forbid it), so most visitors see the `Times New Roman`/`Georgia` fallbacks. Free on weight; a typographic inconsistency, accepted deliberately. |

The single-file design (one HTML document, no build step) is why 37–39 hold.
Splitting the bundles out would turn 2 requests into 4 and make the bytes
cacheable — it is not worth it for a page read once.

**Delivery is a separate measurement.** `docs/SITE_DELIVERY_AUDIT.md` (2026-11-17)
covers what this table does not: protocol negotiation, per-encoding sizes,
cache headers and validators, conditional requests, SRI, failure modes and the
no-JS/Slow-3G rendering. One correction to item 35 above: the 50.2 kB figure is
what curl gets with `Accept-Encoding: br`; a browser offers
`gzip, deflate, br, zstd` and is answered with **zstd — 53,981 B (52.7 kB)**,
2.9 kB more than gzip. Reproduce with `node scripts/site-delivery-audit.mjs`.

---

## 2. What changed in this PR

| File | Change |
|---|---|
| `site/index.html` | canonical, `og:url` trailing slash, `og:image` (+ type/width/height/alt), `twitter:image` (+ alt), `theme-color`, PNG/ICO icon fallbacks, `WebSite`+`Organization` JSON-LD, `#zap-open` placeholder documented and its URI assigned before unhiding |
| `site/og.png` | new — 1200×630, 63.9 KB, the masthead |
| `site/favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-512.png` | new — the conventional paths now exist |
| `site/sitemap.xml` | new — one `<loc>`, no invented `<lastmod>` |
| `site/.well-known/security.txt` | new — `Contact`/`Expires`/`Canonical`/`Policy`/`Preferred-Languages` |
| `site/404.html` | new — branded 404 served for every miss |
| `site/robots.txt` | `Sitemap:` pointer + `Allow` for `/sitemap.xml` and `/.well-known/security.txt` |
| `site/llms.txt` (+ `.md`, `+.well-known`) | stale `v0.7.2` removed; `bao.network` labelled legacy; all three kept byte-identical |
| `scripts/check-live-site.mjs` | compares **11** paths instead of 4, binary-safe, and asserts content type; the file table is exported so the test suite can use it |
| `__tests__/siteDiscovery.test.ts` | new — 18 assertions over the crawl files, head metadata, icons, JSON-LD, links and the 404 page |
| `AGENTS.md` | the discovery invariants, next to the existing a11y/performance ones |

### Verify

```bash
node scripts/check-live-site.mjs          # 11/11 paths, content types included
npx vitest run __tests__/siteDiscovery.test.ts __tests__/siteLanding.test.ts
```

Axe (0 serious): run with `axe-core@4.10.2` in headless Chrome against `/` and
`/404.html` — `{"violations": {}}` on both. The pre-change page had one
`moderate` (`region`) from Cloudflare's injected hidden anchor, not from our
markup; the new `404.html` had two (`landmark-one-main`, `region`) and was fixed
by wrapping its content in `<main id="main" tabindex="-1">`.

---

## 3. Verified against the deployed host

Merged in #168 (`53db5ab`); GitHub Pages deployed at 16:28Z. Probes below are
read-only and paced, run *after* the deployment, against
`https://court.bao.network`.

| Check | Result |
|---|---|
| `node scripts/check-live-site.mjs` | **11/11 paths match** (bytes **and** content type) — was 4/4 |
| `/sitemap.xml` | 200, `application/xml`, `cache-control: max-age=600` |
| `/.well-known/security.txt` | 200, `text/plain; charset=utf-8` |
| `/favicon.ico` | 200, `image/vnd.microsoft.icon` |
| `/og.png` | 200, `image/png`, 63,889 B |
| `/nonexistent-page-xyz` | **404**, body `<title>No such page - ₿AO Court</title>`, 5.2 kB, link home present |
| canonical / `og:url` / `og:image` / JSON-LD | read out of the live DOM: `https://court.bao.network/`, `https://court.bao.network/`, `https://court.bao.network/og.png`, `["WebSite","Organization"]` — the headers survive Cloudflare's HTML rewrite |
| `http://` → `https://` | still a single 301 |
| axe, live `/` | 0 critical, 0 serious, **1 moderate `region` on `.skip-link`** — identical to the pre-change baseline, and structural: the skip link must be the first focusable element, so it precedes `<main>`. Left as is. |
| axe, live `/404.html` | 0 violations |
| weight | **51.6 kB brotli** for the document (50.2 kB before: +1.4 kB for the added head), 153.4 kB decoded, **2 requests**, 0 images, 0 fonts, 0 stylesheet links |

The deferred `check-live-site` workflow is now meaningful: it fails if any of
the eleven paths drifts, which is why the sitemap and `security.txt` are added
to it rather than left to a scheduled curl nobody reads.

### Timestamps

`security.txt` carries an `Expires` that the test suite refuses once it is past
or more than a year out — so the file cannot sit here looking authoritative for
years. Renew by editing that one line (next date: 2027-05-17).

