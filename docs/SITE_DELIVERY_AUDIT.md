# Site delivery audit — how `court.bao.network` reaches a reader

On 2026-11-17 `bao.markets` answered **429** at the edge while
`https://court.bao.network/` answered **200**. That makes the court landing page
the one BAO surface a visitor can still reach during an edge incident — so *how*
it is delivered, and what happens when JavaScript, bandwidth or the origin are
taken away, is part of the protocol's public face, not an ops footnote.

Everything below is **measured**, read-only, paced at ≤ 1 request/second against
production (`2026-11-17T16:35–16:45Z`, `origin/main` = `6228954`). Where a
number came from a browser it says so; where a client could not verify something
it says that too.

Reproduce the HTTP half with:

```bash
node scripts/site-delivery-audit.mjs       # 37 PASS / 6 WEAK / 1 FINDING today
node scripts/check-live-site.mjs           # 11/11 paths byte-identical
```

---

## 1. The measured table

| # | Area | Verdict | Observed |
|---|---|---|---|
| 1 | **Progressive enhancement (no JS)** | **PASS** | 8,964 visible characters vs 8,987 with JS. Nav, masthead `<h1>`, every CTA, the paper link and all 22 links render and are tappable. Only two things change: the folio date reads `Today` instead of `Tuesday, November 17, 2026`, and Cloudflare's email obfuscation leaves `[email protected]` where `baocourt@rizful.com` belongs. Nothing critical breaks. |
| 2 | **Slow 3G** | **PASS** | At 400 kb/s / 400 ms RTT: FCP **1,412 ms**, DCL **1,833 ms**, load **1,837 ms**, and the full text is present at DCL. The masthead paints at 1.4 s, before the document finishes. |
| 2b | **Script blocked** | **PASS** | Blocking every `*.js` request aborts exactly **1** request (Cloudflare's injected `email-decode.min.js`); text is 8,985 chars. Blocking the inline scripts with `script-src 'none'` yields the no-JS page (8,964 chars). No JS-dependent blanking anywhere — there is no SPA shell to wait for. |
| 3 | **Protocol** | **PASS** | **HTTP/2** negotiated over TLS 1.3 (ALPN probe `h2`). TTFB 96–118 ms on a reused session, 175–300 ms cold. |
| 3b | **HTTP/3** | **WEAK** | Advertised: `alt-svc: h3=":443"; ma=86400`. Not verified: no QUIC client in this checkout (Node and curl here speak h2 only). An ALPN probe offering `h3` over TCP is answered "No ALPN negotiated", which is expected — h3 is UDP. |
| 3c | **Compression** | **PASS / WEAK** | `content-encoding` is negotiated per request: identity 153,374 B → **gzip 51,055 B (33.3%)**, br 51,573 B (33.6%), **zstd 53,981 B (35.2%)**. A browser sends `gzip, deflate, br, zstd` and **gets zstd** — 2,926 B (+5.7%) heavier than gzip, ~2.4 kB heavier than br. See F-3. |
| 3d | **`Vary`** | **PASS** | `vary: Accept-Encoding` on every response, including the 304s, so a shared cache cannot hand a zstd body to a gzip client. |
| 4 | **Caching** | **PASS** | HTML `max-age=600` (10 min, revalidate — not pinned), images `max-age=14400`, texts `600`–`14400`. Full table in §5. |
| 4b | **Validators** | **PASS / WEAK** | Every asset has a validator; `If-None-Match` on images/texts → **304, 0 B**. HTML and 404.html carry **no ETag on a 200** — revalidation runs on `If-Modified-Since`, which also returns **304** (a 304 does include a weak ETag). See F-4. |
| 4c | **Edge cache of HTML** | **FINDING** | `cf-cache-status: DYNAMIC` — Cloudflare does not cache the document. Every view is a GitHub Pages fetch. See F-1. |
| 5 | **Asset integrity** | **PASS** | 0 authored `<script src>`, 0 stylesheet links, 0 `<img>`, 0 `@font-face`, 5 inline `<script>` (one is JSON-LD), 1 inline `<style>`. Nothing is fetched cross-origin, so SRI has nothing to protect. The single non-authored script is Cloudflare's same-origin `email-decode.min.js` — rewritten in flight, so SRI cannot apply to it (documented, F-7). |
| 5b | **Fonts** | **PASS (documented)** | `Newsreader`, `JetBrains Mono`, `Space Grotesk` are named in CSS and never loaded: 0 font requests, 0 preloads, 0 `@font-face`. Deliberate — single-file design, already recorded as `DISCOVERY_AUDIT.md` item 39. Nothing to preload, nothing to add `crossorigin` to. |
| 6 | **Failure modes** | **PASS** | Bogus `Accept-Encoding` → **200** identity. `If-None-Match: "garbage"` → **200** full body. Unknown path → **404** with the repo's branded page. HEAD and GET headers identical for `content-type, cache-control, vary, content-encoding, etag, last-modified, strict-transport-security`. No 5xx in any probe. |
| 6b | **`/` vs `/index.html`** | **PASS** | Both **200**, same `<title>`, same `canonical https://court.bao.network/`. Bytes differ only by Cloudflare's per-response nonce (bot anchor `cdn-cgi/content?id=…` and a randomised `data-cfemail`), which is why HTML is never byte-compared (see `check-live-site.mjs`). |
| 7 | **Weight** | **PASS** | **2 requests, ~54.6 kB** on the wire (document 53,984 B zstd + 661 B email-decode) for 153,374 B decoded. 0 images, 0 fonts, 0 stylesheets. Largest published assets: `og.png` 63,889 B (social card only — never fetched by a page view), the document 53,981 B, `icon-512.png` 6,691 B (JSON-LD/scrapers only). |
| 8 | **Axe** | **PASS** | axe-core 4.10.2, default rules, live `/`: **0 violations** at 1280×900 (35 passes) and **0** at 390×844 (36 passes). |

Score today: **37 PASS · 6 WEAK · 1 FINDING**, no regression.

---

## 2. Progressive enhancement — what a reader without JavaScript sees

Measured in headless Chromium (`javaScriptEnabled: false`, 1280×900) against
`https://court.bao.network/`, compared with the same page script-enabled.

| | no JS | with JS |
|---|---|---|
| visible characters (`innerText`) | **8,964** | 8,987 |
| links rendered and clickable | **22** | 21 |
| nav / `<h1>` / skip link | visible | visible |
| `Read the paper` / `Source code` / `The ₿AO Network` | present, 36 px tall | present, 36 px tall |
| pop-up panels | 1 hidden (`#zap-panel` + 11 children) | same, hidden until opened |
| requests | 1 (the document) | 2 (+ `email-decode.min.js`) |

The **entire difference is 23 characters in two places**:

1. the folio date — `Today` instead of `Tuesday, November 17, 2026` (the script
   writes it during parse so the masthead does not reflow, `SITE_ROUND5_PERFORMANCE.md` §1);
2. the court address — Cloudflare's email obfuscation rewrites
   `baocourt@rizful.com` into `<a class="__cf_email__">[email protected]</a>` and
   only its injected `email-decode.min.js` restores it.

There is no `<noscript>` warning because there is nothing to warn about, and no
content is revealed by script — the document is the content. The one thing a
no-JS reader cannot do is the zap/pay panel and the copy-address button, both of
which are inherently interactive.

---

## 3. Slow 3G and the blocked-bundle case

Chromium DevTools "Slow 3G" emulation (400 kb/s down, 400 kb/s up, 400 ms RTT),
same page:

```
FCP            1,412 ms
DOMContentLoaded 1,833 ms
load            1,837 ms
text at DCL     8,987 characters (complete)
body height     4,086 px
```

This is the static-site analogue of the SPA-shell problem, and the page is on
the right side of it: **the text is in the HTML**, and the 93 kB of inline
vendor JavaScript (`@noble/*`, the NWC client, `node-qrcode`) sits **after
`</main>` and `</footer>`**, so it cannot delay the visible page. Only the
1,263-character date script runs inside the content path, deliberately, before
`<main>` exists.

Blocking script delivery entirely:

* `route('**/*.js') → abort` — **1 request aborted** (Cloudflare's
  `email-decode.min.js`), 8,985 chars, everything visible.
* `script-src 'none'` on the document — 8,964 chars, date `Today`, zap panel
  hidden; otherwise pixel-identical to the no-JS run. Console shows only the CSP
  refusals. **Nothing blanks.**

---

## 4. Protocol and compression, per encoding

```
identity  200  153,374 B
gzip      200   51,055 B   33.3%   content-encoding: gzip
br        200   51,573 B   33.6%   content-encoding: br
zstd      200   53,981 B   35.2%   content-encoding: zstd
"gzip, deflate, br, zstd" → zstd  (what a browser actually receives)
"bogus-enc" → 200 identity, no error
```

Sizes are DATA-frame payload bytes from a single HTTP/2 session; they wobble by a
few tens of bytes between requests because Cloudflare rewrites the document each
time (per-response bot anchor + randomised `data-cfemail`), which is why a ±0.1%
difference between two runs is expected and not a regression.

* `HTTP/2` over `TLSv1.3`, `alt-svc: h3=":443"; ma=86400`.
* No `content-length` on compressed HTML (chunked over h2) — expected.
* Images are **not** compressed (`og.png`, `icon-512.png`, `favicon-32.png`,
  `apple-touch-icon.png` arrive as `image/png`, no encoding). Correct.
* `favicon.ico` **is** gzip-encoded: 544 B on the wire for a 521 B file — the
  encoding *inflates* it by 23 B (F-6).

---

## 5. Caching, per asset class

| asset | class | wire B | decoded B | `cache-control` | validator | conditional |
|---|---|---|---|---|---|---|
| `/` | html | 53,981 (zstd) | 153,374 | `max-age=600` | `last-modified` only | `If-Modified-Since` → **304** |
| `/404.html` | html | 2,132 (zstd) | 5,196 | `max-age=600` | `last-modified` only | **304** |
| `/robots.txt` | text | 1,588 (gzip) | 3,339 | `max-age=14400` | `W/"6afc8064-d0b"` | **304** |
| `/sitemap.xml` | text | 531 (gzip) | 857 | `max-age=600` | `W/"6afc8064-359"` | **304** |
| `/llms.txt` | text | 1,691 (gzip) | 4,137 | `max-age=600` | `W/"6afc8064-1029"` | **304** |
| `/llms.md` | text | 1,691 (gzip) | 4,137 | `max-age=600` | `W/"6afc8064-1029"` | **304** |
| `/.well-known/security.txt` | text | 600 (gzip) | 985 | `max-age=600` | `W/"6afc8064-3d9"` | **304** |
| `/og.png` | image | 63,889 | 63,889 | `max-age=14400` | `"6afc8064-f991"` | **304** |
| `/icon-512.png` | image | 6,691 | 6,691 | `max-age=14400` | `"6afc8064-1a23"` | **304** |
| `/apple-touch-icon.png` | image | 2,225 | 2,225 | `max-age=14400` | `"6afc8064-8b1"` | **304** |
| `/favicon-32.png` | image | 499 | 499 | `max-age=14400` | `"6afc8064-1f3"` | **304** |
| `/favicon.ico` | image | 544 (gzip) | 521 | `max-age=14400` | `W/"6afc8064-209"` | **304** |
| unknown path | 404 | 2,046 (gzip) | 5,197 | **(absent)** | **(none)** | — |
| `/cdn-cgi/.../email-decode.min.js` | edge js | 661 (zstd) | ~1,004 | `public` (no `max-age`) | — | — |

Every 304 replayed `cache-control` and `vary`, so a shared cache can refresh its
metadata without refetching.

The HTML freshness is right for a page that changes on every deploy: **10
minutes, revalidate**, not `max-age=31536000`. With no ETag it revalidates by
`If-Modified-Since` (F-4), which costs a request but returns an empty 304.

---

## 6. Findings (each with a reproduction)

Owner column: **edge** = Cloudflare zone rule, **origin** = GitHub Pages, **repo**
= fixable here. Nothing in this list is repo-fixable except the guard script
added alongside this document.

### F-1 · The document is never cached at the edge — **FINDING (edge)**

```bash
curl -sI https://court.bao.network/ | grep -iE 'cf-cache-status|x-cache|cache-control'
# cache-control: max-age=600
# x-cache: HIT            ← GitHub's Fastly, in front of the Pages origin
# cf-cache-status: DYNAMIC ← Cloudflare, in front of the reader
```

Cloudflare passes every view through to GitHub Pages. TTFB is still ~100 ms
because GitHub's own Fastly caches it, but **nothing at the public edge survives
a GitHub Pages outage** — for a static 153 kB document that is a self-inflicted
single point of failure. Rule in §7.

### F-2 · There is no second origin — **FINDING (origin config)**

```bash
curl -sSI https://baocommunity.github.io/bao-court/ | grep -i location
# location: https://court.bao.network/
```

GitHub Pages 301s its own `*.github.io` host to the custom domain, so the
document exists at **exactly one origin behind exactly one Cloudflare zone**. If
the rule that produced the `bao.markets` 429 were extended to the `bao.network`
zone, court.bao.network would go with it and there is no origin-side fallback to
point readers at. Mitigations are edge-side only (cache + serve-stale, §7); the
repo cannot create a second origin.

### F-3 · zstd is negotiated by default and is the largest of the three — **WEAK (origin/edge)**

```bash
for e in gzip br zstd; do
  printf '%-5s ' $e
  curl -sS -o /dev/null -H "Accept-Encoding: $e" -w '%{size_download}\n' https://court.bao.network/
done
# gzip  51055
# br    51573
# zstd  53981
```

A browser offers `gzip, deflate, br, zstd` and receives **zstd**, 2,926 B
(+5.7%) more than gzip and ≈2.4 kB more than br. The compressor that picks the
encoding is in front of this repo (the response carries both GitHub/Fastly
`via: 1.1 varnish` and Cloudflare `cf-ray`), and GitHub Pages exposes no
encoding preference, so this is documented, not fixed. Practical effect on the
quoted weight: `DISCOVERY_AUDIT.md` §1.6 measured **50.2 kB brotli** with curl's
`Accept-Encoding: br`; a real browser today receives **52.7 kB** (53,981 B).
§8 quotes the browser number.

### F-4 · HTML and 404 have no ETag on a 200 — **WEAK (origin)**

```bash
curl -sI https://court.bao.network/ | grep -ic etag      # 0
curl -sS -o /dev/null -D- -H "If-Modified-Since: $(curl -sI https://court.bao.network/ | grep -i last-modified | cut -d' ' -f2-)" https://court.bao.network/ | head -1
# HTTP/2 304      (and this 304 *does* carry etag: W/"6afc8064-2550a")
```

`If-Modified-Since` gives a working 304, but a second-granularity weak validator
means a redeploy within the same second as a cached copy is indistinguishable.
Adding an ETag is GitHub Pages' call; `_headers` files are ignored there.

### F-5 · 404 responses carry no cache policy — **WEAK (origin)**

```bash
curl -sSI https://court.bao.network/definitely-not-a-page-xyz | grep -iE 'cache-control|etag'
# (nothing)
```

A miss returns 404 + the branded page with **no** `cache-control` and no
validator, so every intermediary applies its own default. The body is correct
(`<title>No such page - ₿AO Court</title>`, `noindex`, link home).

### F-6 · `favicon.ico` is compressed larger — **WEAK (origin/edge)**

```bash
curl -sS -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}\n' https://court.bao.network/favicon.ico   # 544
curl -sS -o /dev/null -H 'Accept-Encoding: identity' -w '%{size_download}\n' https://court.bao.network/favicon.ico # 521
```

23 B larger compressed than plain. Harmless at this size; recorded so nobody
"optimises" it twice.

### F-7 · The one script the repo does not own — **WEAK (edge)**

Cloudflare appends `/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js`
(661 B, zstd) with `cache-control: public` and **no `max-age`**, so every
navigation refetches or revalidates it. It is same-origin, injected after the
document is authored, and cannot carry an `integrity` attribute. It is also the
reason a no-JS visitor sees `[email protected]` instead of the court address
(§2). Turning email obfuscation off in the Cloudflare dashboard removes both the
request and the no-JS text difference.

---

## 7. The edge rules that would close F-1 and soften F-2

Copy-paste intent for whoever holds the `bao.network` zone. (Wording in the
Cloudflare dashboard moves; the behaviour is what matters, and §7.1 is how to
check it landed.)

1. **Cache Rule** — *if* `http.host eq "court.bao.network"`
   *and* `http.request.method eq "GET"` → **Eligible for cache**,
   Edge TTL *respect origin* (`max-age=600`), Browser TTL *respect origin*.
   Never cache anything with a query string or a non-200 status beyond the
   origin's own header.
2. **Serve stale** on that rule: `stale-while-revalidate` ≈ 1 day,
   stale-if-error ≈ 7 days. This is the actual resilience win: during a GitHub
   Pages incident the edge keeps answering the last good copy instead of a 5xx.
3. **Do not cache `/404.html` by status** — the 404 body may be cached at its
   origin headers once F-5 is decided, but a blanket "cache everything" must not
   pin a 404 for a path that later exists.
4. **Compression (F-3):** no action available — GitHub Pages chooses the
   encoding. Record the 2.9 kB rather than chase it. If the document is ever
   served from BAO's own origin (bao8gb), prefer `br`/`gzip` over `zstd` for
   this payload.

About deployments: a 600 s edge TTL means a deploy can lag up to 10 minutes at
the public edge. `check-live-site.mjs` is unaffected — it cache-busts with
`?cb=` and is answered by the origin — so the workflow keeps its meaning. A
human verifying a deploy in the first 10 minutes should purge the URL.

### 7.1 Verify the rule landed

```bash
curl -sI https://court.bao.network/ | grep -iE 'cf-cache-status|age'
# expected after the rule:  cf-cache-status: HIT   and   age: <seconds>
```

---

## 8. Weight, measured the way a browser measures it

| | value |
|---|---|
| requests on first load | **2** (document + Cloudflare's injected `email-decode.min.js`); **1** with JS off |
| transfer | **~54.6 kB** — 53,984 B document (zstd) + 661 B script |
| decoded document | **153,374 B** (Chromium reported 153,072 B for its own copy) |
| images / fonts / stylesheets | **0 / 0 / 0** |
| largest published asset | `og.png` **63,889 B** — social card, never fetched by a page view |
| second / third | the document **53,981 B**; `icon-512.png` **6,691 B** — JSON-LD logo and scraper favicon only |
| CSS / JS split inside the document | 22.4 kB inline `<style>` (one block); 103.9 kB inline `<script>` (one JSON-LD block, a 1.3 kB date script between header and `<main>`, the 11.4 kB page script, and **90.6 kB** of vendored `@noble/*` + NWC + `node-qrcode`, all parsed after `</main>`) |

A headless Chromium first load fetches no favicon at all (the declared icon is a
`data:` SVG); a headed browser may add one 499 B request for
`/favicon-32.png`. Both numbers are inside the same budget.

---

## 9. What changed in this repo, and what did not

| Item | State | Why |
|---|---|---|
| Page bytes | **unchanged** | Nothing measured justified a change: content already precedes the only large script, there are no subresources to preload, no fonts to `crossorigin`, and no SRI target to harden. Changing the page for a header problem would be motion without effect. |
| Cache headers (F-1, F-4, F-5) | **documented** | `site/` is published by GitHub Pages, which cannot set response headers; `_headers`, `netlify.toml`, `<meta http-equiv>` are all ignored for caching. The rule lives at the edge (§7). |
| Compression (F-3, F-6) | **documented** | Chosen by the CDN in front of the repo's origin. |
| `proto`/`h3` advertisement | **documented** | The host already advertises h3. |
| Fonts, SRI, preload | **verified N/A** | No `@font-face`, no third-party asset, nothing to preload. |
| `scripts/site-delivery-audit.mjs` | **added** | The HTTP half of this table is now a one-command, dependency-free, 1 req/s check: it fails the build only on regressions the repo can act on (5xx, missing `Vary`, a conditional that returns a body, HEAD/GET drift, a third-party asset without SRI). |
| `package.json` → `npm run audit:site` | **added** | Discoverability, same as `check-live-site`. |
| `docs/DISCOVERY_AUDIT.md` §1.6 | **cross-linked** | The performance items there are the discovery view; this file is the delivery view, and the weight figure is corrected to the browser's negotiated encoding. |

Reference for the JS-off harness and the axe run (a browser is unavoidable for
§2–§3): Playwright (`chromium`), `javaScriptEnabled: false` for the no-JS pass,
`Network.emulateNetworkConditions` at 400 kb/s + 400 ms for Slow 3G,
`axe-core@4.10.2` injected for the accessibility pass. DevTools does the same
three things by hand (Settings → Debugger → Disable JavaScript; Network →
Slow 3G; Lighthouse/axe extension), which is why no browser dependency was added
to this repo for a quarterly audit.

---

## 10. Bottom line

The page is a **single static document with no subresources**, and it behaves
like one: without JavaScript it is the same page minus a date and an
un-obfuscated email address; on a 400 kb/s link its text is complete at 1.8 s;
with every script blocked it does not blank. The delivery layer is the weak
part, and none of the weak points are in this repo: the document is not cached
at the public edge, the origin has no fallback hostname, and the negotiated
encoding is the largest of the three on offer. Two of those are one cache rule
away from being fixed, and that rule is written down here instead of being
rediscovered during the next incident.
