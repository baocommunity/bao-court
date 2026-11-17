# The landing page, measured — round 5 of the GUI red-team

`site/index.html` is one static document on GitHub Pages behind Cloudflare. The
GUI red-team's round 5 pass
([`bao.markets/docs/benchmarks/GUI_REDTEAM_ROUND5.md`](https://github.com/baocommunity/bao.markets/blob/main/docs/benchmarks/GUI_REDTEAM_ROUND5.md),
PR #3008) measured it on production and found two things:

| finding | measured | budget |
|---|---|---|
| **CLS 0.167** — `main#main` shifted **23 px at 593 ms** | the page's only shift | 0.1 |
| two of three CTAs at **36 px** tall (`Read the paper` 166×36, `The ₿AO Network` 175×36) | `—` | 44 px floor |

Both are fixed here, and both fixes are measurable in the same harness.

---

## 1. CLS 0.167 → 0 (finding 3)

### What was moving

The `.folio` line in the masthead is a **wrapping** flex row:

```html
<div class="folio">
  <span>Vol. I · No. 1</span><span class="dash"></span>
  <span id="folio-date">Today</span><span class="dash"></span>
  <span>Threshold Edition</span>
</div>
```

`#folio-date` is replaced by the page script at the end of `<body>` with the
long form of today's date. "Today" is one short word; `Tuesday, 17 November
2026` is not. At phone width the row goes from **two lines to three**, the
masthead grows with it and `main` is pushed down by exactly one line box plus
one row gap:

```
26 px?  no — measured: .folio 38 px → 61 px  (+23 = 15 px line + 8 px gap)
        header       177.6 px → 200.6 px
        main#main    y=222.6 → y=245.6   (CLS 0.1671, at 402 ms)
```

Row counts by width (the settled date, measured at 13 widths): **three rows at
≤ ~420 px**, two rows from 430 to 600 px, one row from 640 px up. So a
`min-height` reservation cannot be right at every width — it would leave dead
space in the middle band and at desktop.

### The fix

Write the date **during parse**, from a small script placed between the masthead
and `<main>` (`site/index.html`). The first layout is then already the settled
layout at every width, so there is nothing to reserve and nothing to shift. The
late script keeps the year (footer, below the fold) and no longer touches the
date.

| | FCP | LCP | shift | CLS |
|---|---|---|---|---|
| before | 304 ms | 304 ms | `main#main` +23 px @ 402 ms | **0.1671** |
| after | 216 ms | 248 ms | **none** | **0** |

(Chromium, cold cache, CDP Slow 4G, 412×915, `layout-shift`
`PerformanceObserver`, the round-5 harness's own `runPerf`.)

## 2. Tap targets: 2 of 3 CTAs at 36 px → 0 (finding 9)

`.btn` is `padding: 0.55rem 1.25rem` with an 11 px mono label and a 1 px border,
which lands at 36 px. The two hero buttons now get a floor of 44 px **where it
matters** and nowhere else:

```css
@media (pointer: coarse), (max-width: 40rem) {
  .lead .btn, .cta-row .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; }
}
```

`min-height`, not a bigger font or more padding: the label size, the tracking and
the visual weight are unchanged — only the hit area grows. The rule is scoped to
`.lead`/`.cta-row`, so the compact buttons inside the support panel (Copy, NWC,
the zap actions) keep their own 24 px sizing.

| | Pixel 7 (412) | iPhone 13 (390) |
|---|---|---|
| before | 2 / 3 CTAs under 44 px (36 px tall) | 2 / 3 |
| after | **0 / 3** | **0 / 3** |

Navigation was already clean (6 / 6, 44 px, from the round-2 footer/`min-height`
work) and stays clean.

**Desktop is untouched.** At 1440×900 the two CTAs still measure 166×36 and
175×36, `.cta-row` is 992×36, `main` stays at y=225 h=3718, the header at 180 px
and the document at 4 086 px — every box identical before and after, because the
rule is inside a coarse-pointer/narrow-width query and a desktop browser matches
neither.

---

## 3. Reproducing

The measurement runs from a `bao.markets` checkout (it owns the harness):

```bash
# before / after copies of the page
git show <base>:site/index.html > /tmp/court-before/index.html
cp site/index.html            /tmp/court-after/index.html

cd ~/Documents/bao.markets
node scripts/gui-redteam/round5/serve.mjs /tmp/court-before 8098
node scripts/gui-redteam/round5/serve.mjs /tmp/court-after  8099

node scripts/gui-redteam/round5/local.mjs --url court=http://127.0.0.1:8098/ --checks perf
node scripts/gui-redteam/round5/local.mjs --url court=http://127.0.0.1:8099/ --checks perf,mobile
```

## 4. What still is not fixed

- **The page still declares families it does not load** (`Space Grotesk`,
  `Newsreader`, `JetBrains Mono`), so it renders in system fallbacks (round-5
  finding 5, `info`). That is deliberate: it is a 52 kB single-file document with
  no build step, and `font-src 'self'` + a GitHub Pages deploy would need font
  files added as separate assets. The per-engine line-break differences on this
  page (Firefox moved 0 boxes; WebKit accumulates ~100 px in `main` height) come
  from that, not from layout.
- **LCP** was already excellent (444 ms on production) and is not touched.
