# Security headers for court.bao.network

The landing page (`site/index.html`) is served by **GitHub Pages**, which cannot
set HTTP response headers. Everything that must be a *header* is therefore the
edge operator's job, and until the rule below is applied those findings stay
**open**. This document is the copy-paste source for that rule.

Origin: GUI red-team cycles 1–3 against the deployed host — see
`docs/benchmarks/gui-redteam/FINDINGS.md` in the exercising repo
(`bao.markets`, commit `8539518a3`) for the raw evidence:
`content-security-policy` absent, `x-frame-options` absent,
`referrer-policy` absent, and a confirmed framable page
(`framable: true`, `childTitle: "₿AO Court - Threshold Oracle for Dispute
Resolution"`).

## 1. What is fixed in this repo, and what is not

| Finding | Where it is fixed | State |
|---|---|---|
| Two `<h1>` elements | `site/index.html` — the masthead nameplate keeps the only `<h1>`; the lead headline is an `<h2>` with element-agnostic CSS (`:is(h1, h2)`), so the rendered box is byte-for-byte the same | **FIXED in-repo** (locked by `__tests__/siteLanding.test.ts`) |
| No `Referrer-Policy` | `<meta name="referrer" content="strict-origin-when-cross-origin">` — a meta referrer policy is honoured for navigations and subresource requests from this document | **FIXED in-repo** (defence in depth) |
| No CSP | `<meta http-equiv="Content-Security-Policy" …>` in `site/index.html` | **PARTIALLY FIXED in-repo** — a meta policy is enforced, but it cannot be the authoritative control (see §2) |
| No framing protection / page is framable | *nothing in-repo can fix this* | **OPEN** until the edge rule in §3 is applied |
| No `X-Frame-Options` | *cannot be set by a meta element, at all* | **OPEN** until the edge rule in §3 is applied |
| No `Permissions-Policy` | *header-only* | **OPEN** until the edge rule in §3 is applied |
| `X-Content-Type-Options` | already sent by GitHub Pages (`nosniff`) | closed |
| HSTS | already sent by GitHub Pages (`max-age=31536000; includeSubDomains; preload`) | closed |

The in-repo meta policy is **defence in depth behind the header, never a
replacement for it**. A response header and a meta element are both enforced
when both are present, so the header wins wherever it is stricter.

## 2. What a `<meta>` policy cannot do (do not pretend otherwise)

Per CSP Level 3 these directives are **ignored when delivered in a meta
element**, and Chromium logs a console warning if you try:

- `frame-ancestors` → anti-framing stays impossible without a header
  (`X-Frame-Options: DENY` or `frame-ancestors 'none'`).
- `report-uri` / `report-to` → no violation reporting from meta.
- `sandbox` → cannot be applied by meta.

Two further consequences of meta-only delivery:

- A meta policy is parsed when the document is parsed, so anything the browser
  fetched *before* it (nothing today — it is the first tag after the charset and
  viewport) would be ungoverned.
- The policy is part of the **document**, so it is served by every host that
  mirrors the file. That is a feature for the `bao.network/court/` mirror, but
  it also means a per-host header policy must still be applied per host.

The in-repo policy is deliberately `'unsafe-inline'` for scripts and styles:

- the page is a single file — three vendored bundles (`@noble/*`, the NIP-47 NWC
  client, `node-qrcode`) and the page script are inline `<script>`, and the
  newspaper theme is one inline `<style>` plus style attributes;
- Cloudflare rewrites this document in flight (email obfuscation appends a
  same-origin `email-decode` script and rewrites the address), so byte-exact
  hashes would break on the deployed copy rather than on the source;
- on the edge the operator can tighten this to a nonce-based policy, because
  there it can rewrite the document. The rule below keeps `'unsafe-inline'` so
  that the header and the meta policy agree and neither breaks the page.

`'unsafe-inline'` still leaves real value: the policy forbids *third-party*
loads, plugins/objects, `<base>` hijacking and form posting, and pins the one
API origin the page calls. It does **not** stop an inline injection — which is
why the "no injection sink" property (a static document with no user input)
matters, and why this is recorded as defence in depth rather than as a fix.

## 3. The edge rule (Cloudflare) — copy-paste

Apply a **Modify Response Header** rule on the zone that proxies
`court.bao.network`.

**Dashboard:** Rules → Transform Rules → **Modify Response Header** → Create
rule.

- Rule name: `court landing security headers`
- When incoming requests match… **Custom filter expression**:

```
(http.host eq "court.bao.network")
```

- Then… **Set static** for each header:

| Header name | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://relay.bao.network https://relay.bao.markets wss:` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |
| `Permissions-Policy` | `accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=()` |

Equivalent single object for whoever applies it from code (a Worker on a
`court.bao.network/*` route, or infrastructure-as-code):

```js
const headers = {
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://relay.bao.network https://relay.bao.markets wss:",
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(), usb=(), xr-spatial-tracking=()',
};
// Worker route: rewrite the response headers, keep the body and status.
const upstream = await fetch(request);
const out = new Response(upstream.body, upstream);
for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
return out;
```

Notes the operator must not skip:

- **Keep `'self'` in `script-src`.** Cloudflare's email-obfuscation script is
  served same-origin from `/cdn-cgi/scripts/…/email-decode.min.js`; a policy
  without `'self'` breaks the deployed page while the source still looks fine.
- **`wss:` is broad on purpose.** The NWC panel pays through the relays named in
  the user's own connection string, so the origin is not knowable in advance.
  Narrow it only if that panel is removed.
- **`form-action` and `base-uri` are already closed by the meta policy**; the
  edge repeats them so the header alone is a complete policy.
- **`X-Frame-Options: DENY`** is correct here: nothing in the BAO estate frames
  `court.bao.network` (the `bao.network/court/` presence is a byte-for-byte copy
  rendered as its own page, not an iframe). If a future embed is needed, switch
  to `frame-ancestors 'self' https://bao.markets` and drop the XFO header.

### The mirror needs the same rule

`baocommunity/bao.network` mirrors `site/index.html` byte-for-byte and renders
it at `https://bao.network/court/`. The **meta** tags travel with the file, so
fixing this repo fixes them there too; the **header** rule must be applied on
that host as well — it cannot be fixed from either repo. Until then the mirror
host keeps the open framing / header findings even though the meta policy and
referrer meta are current.

## 4. Verifying the edge rule

```bash
curl -sSI https://court.bao.network/ \
  | grep -iE 'content-security-policy|x-frame-options|referrer-policy|permissions-policy|x-content-type-options|strict-transport-security'
```

Expected: all six present, `x-frame-options: DENY`, `content-security-policy`
carrying `frame-ancestors 'none'`. Then confirm the page still works in a real
browser (the CSP must not break the inline bundles):

```bash
node scripts/check-live-site.mjs      # discovery documents still byte-identical
```

The framing probe that produced the finding is the iframe test in
`bao.markets` `scripts/gui-redteam/checks/`; the same probe must report
`framable: false` once the rule is live.

## 5. What stays open

Until §3 is applied to `court.bao.network` (and to the mirror host):

- **framing / clickjacking** — the page is still framable;
- **no `X-Frame-Options`** and **no `frame-ancestors`**;
- **no `Permissions-Policy`**;
- a CSP that an injected **inline** script would survive (`'unsafe-inline'`).

All four are edge-only and are recorded as open, not as closed by this repo's
change.
