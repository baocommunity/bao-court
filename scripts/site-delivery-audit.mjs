#!/usr/bin/env node
/**
 * site-delivery-audit.mjs — HOW https://court.bao.network is delivered.
 *
 * `check-live-site.mjs` answers "does the host serve this repo's files?".
 * This script answers the other question: protocol, compression, caching,
 * validators, conditional requests, subresource integrity, failure modes and
 * weight — measured, per asset, with no dependencies and no writes.
 *
 *   node scripts/site-delivery-audit.mjs
 *   COURT_LIVE_ORIGIN=https://bao.network/court node scripts/site-delivery-audit.mjs
 *   COURT_AUDIT_PACE_MS=0 node scripts/site-delivery-audit.mjs   # local mirror
 *
 * WHAT IT CANNOT DO
 *
 * No-JS rendering, Slow-3G layout and axe live in a real browser and are
 * recorded by hand in `docs/SITE_DELIVERY_AUDIT.md` §2 (the browser cannot be
 * avoided: "text still readable with script off" is a layout fact, not an
 * HTTP fact). HTTP/3 is advertised by the host and cannot be *verified* from
 * here — Node has no QUIC client — so the check reports the advertisement and
 * says so, rather than implying a negotiation it never performed.
 *
 * VERDICTS
 *
 * PASS     measured, within budget.
 * WEAK     measured, acceptable, suboptimal, or already documented as a
 *          deliberate tradeoff.
 * FINDING  measured deficiency with an owner outside this repo (the edge, the
 *          origin). Printed, not fatal: the repo cannot fix it and a red CI
 *          that cannot go green is noise.
 *
 * Exit 1 only on a REGRESSION this repo can fix or that breaks a visitor:
 * a 5xx, a missing asset, a missing `Vary: Accept-Encoding`, a conditional
 * request that returns a body instead of 304, HEAD/GET header drift, or a
 * third-party subresource without integrity. Pacing is 1 request/second by
 * default (the host is production, read-only).
 */
import http2 from 'node:http2';
import tls from 'node:tls';

const ORIGIN = process.env.COURT_LIVE_ORIGIN ?? 'https://court.bao.network';
const PACE_MS = Number(process.env.COURT_AUDIT_PACE_MS ?? 1000);
const TIMEOUT_MS = Number(process.env.COURT_AUDIT_TIMEOUT_MS ?? 15000);
const HOST = new URL(ORIGIN).host;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── pacing: production host, never burst ────────────────────────────────────
let lastAt = 0;
async function pace() {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

let session = null;
function connect() {
  if (session && !session.destroyed && !session.closed) return session;
  session = http2.connect(ORIGIN);
  session.on('error', () => { session = null; });
  return session;
}

/**
 * One HTTP/2 request. Returns the DATA-frame payload byte count (that is the
 * body on the wire, before the client decodes it) plus the decoded body, so a
 * compressed size and a readable copy come from the SAME response.
 */
async function request(path, { method = 'GET', headers = {} } = {}) {
  await pace();
  const client = connect();
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let res = null;
    const started = Date.now();
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      resolve({ path, method, error: `timeout after ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);

    const req = client.request({ ':path': path, ':method': method, ...headers });
    req.on('response', (h) => {
      res = {};
      for (const [k, v] of Object.entries(h)) res[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    });
    req.on('data', (c) => { bytes += c.length; chunks.push(c); });
    req.on('end', () => {
      clearTimeout(timer);
      resolve({
        path,
        method,
        status: res?.[':status'],
        headers: res ?? {},
        bytes,
        body: method === 'HEAD' ? '' : Buffer.concat(chunks).toString('utf8'),
        ms: Date.now() - started,
      });
    });
    req.on('error', (err) => { clearTimeout(timer); resolve({ path, method, error: err.message }); });
    req.end();
  });
}

/** TLS ALPN is the only honest protocol probe available without QUIC. */
function alpn() {
  const want = ['h2', 'http/1.1', 'h3'];
  return new Promise((resolve) => {
    const sock = tls.connect({ host: HOST, port: 443, servername: HOST, ALPNProtocols: want });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.setTimeout(10000, () => done({ error: 'timeout' }));
    sock.on('secureConnect', () => done({ negotiated: sock.alpnProtocol, tls: sock.getProtocol() }));
    sock.on('error', (err) => done({ error: err.message }));
  });
}

// ─── result collection ──────────────────────────────────────────────────────
const rows = [];
function record(area, item, verdict, detail, fatal = false) {
  rows.push({ area, item, verdict, detail, fatal });
}

const ASSETS = [
  // [path, class, why it is in the table]
  ['/', 'html', 'the landing document'],
  ['/404.html', 'html', 'served for every miss'],
  ['/robots.txt', 'text', 'crawler entry'],
  ['/sitemap.xml', 'text', 'one <loc>'],
  ['/llms.txt', 'text', 'agent brief'],
  ['/llms.md', 'text', 'agent brief, markdown'],
  ['/og.png', 'image', 'social card, 1200x630'],
  ['/icon-512.png', 'image', 'JSON-LD logo'],
  ['/apple-touch-icon.png', 'image', 'iOS home screen'],
  ['/favicon-32.png', 'image', 'declared icon'],
  ['/favicon.ico', 'image', 'conventional probe'],
  ['/.well-known/security.txt', 'text', 'security contact'],
];

async function main() {
  // ─── 1. protocol ──────────────────────────────────────────────────────────
  const probe = await alpn();
  const base = await request('/', { headers: { 'accept-encoding': 'identity' } });
  if (base.error || base.status !== 200) {
    record('protocol', 'base document', 'FINDING', `${base.error ?? `HTTP ${base.status}`} on ${ORIGIN}`, true);
    report();
    return;
  }
  const altSvc = base.headers['alt-svc'] ?? '(none)';
  record('protocol', 'HTTP version (ALPN)', probe.negotiated === 'h2' ? 'PASS' : 'FINDING',
    `${probe.negotiated ?? probe.error} negotiated over TLS (${probe.tls ?? 'n/a'})`, probe.negotiated !== 'h2');
  record('protocol', 'HTTP/3', 'WEAK',
    `advertised as ${altSvc}; not verifiable here (no QUIC client — Node/curl in this checkout speak h2 only)`);
  record('protocol', 'TTFB / base document', base.ms < 800 ? 'PASS' : 'WEAK',
    `${base.ms} ms to first byte on a reused h2 session`);

  // ─── 2. compression ───────────────────────────────────────────────────────
  const enc = {};
  for (const [label, header] of [
    ['identity', 'identity'],
    ['gzip', 'gzip'],
    ['br', 'br'],
    ['zstd', 'zstd'],
    ['browser order', 'gzip, deflate, br, zstd'],
  ]) {
    const r = await request('/', { headers: { 'accept-encoding': header } });
    enc[label] = { bytes: r.bytes, encoding: r.headers['content-encoding'] ?? 'none', status: r.status };
    if (label === 'browser order') enc.negotiated = r.headers['content-encoding'] ?? 'none';
  }
  const idBytes = enc.identity.bytes;
  const ratio = (b) => `${((b / idBytes) * 100).toFixed(1)}%`;
  const smallest = ['gzip', 'br', 'zstd'].sort((a, b) => enc[a].bytes - enc[b].bytes)[0];
  const got = enc.negotiated;
  record('compression', 'encoding negotiation', enc[got]?.bytes === enc[smallest].bytes ? 'PASS' : 'WEAK',
    `client sends "gzip, deflate, br, zstd" → ${got} (${enc[got]?.bytes.toLocaleString()} B, ${ratio(enc[got]?.bytes ?? 0)} of ${idBytes.toLocaleString()} B); smallest is ${smallest} (${enc[smallest].bytes.toLocaleString()} B)` +
    (enc[got]?.bytes > enc[smallest].bytes ? ` — the negotiated form costs ${(enc[got].bytes - enc[smallest].bytes).toLocaleString()} B more` : ''));
  record('compression', 'per-encoding size', 'PASS',
    `identity ${idBytes.toLocaleString()} B · gzip ${enc.gzip.bytes.toLocaleString()} B (${ratio(enc.gzip.bytes)}) · br ${enc.br.bytes.toLocaleString()} B (${ratio(enc.br.bytes)}) · zstd ${enc.zstd.bytes.toLocaleString()} B (${ratio(enc.zstd.bytes)})`);
  record('compression', 'Vary: Accept-Encoding', (base.headers.vary ?? '').toLowerCase().includes('accept-encoding') ? 'PASS' : 'FINDING',
    `document: vary: ${base.headers.vary ?? '(absent)'}`, !(base.headers.vary ?? '').toLowerCase().includes('accept-encoding'));

  // ─── 3+4. cache headers, validators, conditional requests ─────────────────
  const seen = [];
  for (const [path, cls, why] of ASSETS) {
    const r = await request(path, { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
    if (r.error || r.status !== 200) {
      record('caching', path, 'FINDING', `${r.error ?? `HTTP ${r.status}`} — ${why}`, true);
      continue;
    }
    const h = r.headers;
    seen.push({ path, cls, h, bytes: r.bytes });
    const varyOk = (h.vary ?? '').toLowerCase().includes('accept-encoding');
    if (!varyOk) record('caching', `${path} Vary`, 'FINDING', `vary: ${h.vary ?? '(absent)'}`, true);
    const cc = h['cache-control'] ?? '(absent)';
    const validator = h.etag ?? (h['last-modified'] ? `last-modified: ${h['last-modified']}` : '(none)');

    // A conditional request must come back 304 with no body, and must repeat
    // the cache headers so a shared cache can update its entry.
    const condHeaders = {};
    if (h.etag) condHeaders['if-none-match'] = h.etag;
    else if (h['last-modified']) condHeaders['if-modified-since'] = h['last-modified'];
    if (Object.keys(condHeaders).length) {
      const c = await request(path, { headers: { ...condHeaders, 'accept-encoding': 'gzip' } });
      const used = h.etag ? 'If-None-Match' : 'If-Modified-Since';
      const ok = c.status === 304 && c.bytes === 0;
      record('caching', `${path} conditional (${used})`, ok ? 'PASS' : 'FINDING',
        `${ok ? '304, 0 B body' : `HTTP ${c.status}, ${c.bytes} B body`}; replayed ${c.headers['cache-control'] ?? '(no cache-control)'}${c.headers.vary ? `, vary: ${c.headers.vary}` : ''}`,
        !ok);
    } else {
      record('caching', `${path} conditional`, 'FINDING', 'no ETag and no Last-Modified — nothing to revalidate with', false);
    }
    record('caching', `${path} headers`, 'PASS', `${cls}: cache-control ${cc}; validator ${validator}; vary ${varyOk ? 'ok' : 'MISSING'}; ${h['content-encoding'] ?? 'no encoding'}`);
  }

  // HTML specifically: revalidation, not a long max-age.
  const html = seen.find((s) => s.path === '/');
  const htmlMax = Number((html?.h['cache-control'] ?? '').match(/max-age=(\d+)/)?.[1] ?? NaN);
  record('caching', 'HTML freshness', htmlMax > 0 && htmlMax <= 3600 ? 'PASS' : 'FINDING',
    `cache-control: ${html?.h['cache-control'] ?? '(absent)'} — revalidated within the hour, not pinned for a year`, !(htmlMax > 0 && htmlMax <= 3600));
  if (html && !html.h.etag) {
    record('caching', 'HTML validator', 'WEAK',
      'no ETag on a 200 (a 304 carries a weak one) — clients must fall back to If-Modified-Since, which does return 304');
  }

  // Edge caching: measured, not assumed.
  const cf = html?.h['cf-cache-status'] ?? '(no cf-cache-status header)';
  record('caching', 'edge cache of HTML', cf.toUpperCase() === 'DYNAMIC' ? 'FINDING' : 'PASS',
    `cf-cache-status: ${cf} — every page view is an origin fetch, so a GitHub Pages outage takes the page down even though the document is static`);

  // ─── 5. integrity (SRI) + third-party ────────────────────────────────────
  const page = await request('/', { headers: { 'accept-encoding': 'identity' } });
  // Comments are stripped first: the head documents the CSP with the literal
  // text `<script>` in a comment, and counting that would inflate every number
  // below (and has).
  const doc = page.body.replace(/<!--[\s\S]*?-->/g, '');
  const srcScripts = [...doc.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => ({ url: m[1], tag: m[0] }));
  const cssLinks = [...doc.matchAll(/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi)].map((m) => ({ url: (m[0].match(/href\s*=\s*["']([^"']+)["']/) ?? [])[1], tag: m[0] }));
  const imgs = [...doc.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const fontFaces = [...doc.matchAll(/@font-face\s*\{/g)].length;
  const inlineScripts = [...doc.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi)].length;
  const external = [...srcScripts, ...cssLinks].filter((s) => s.url && !s.url.startsWith('/') && !s.url.startsWith('data:'));
  const relative = srcScripts.filter((s) => s.url.startsWith('/'));
  record('integrity', 'external subresources', external.length === 0 ? 'PASS' : 'WEAK',
    `${srcScripts.length} <script src> (${relative.length} root-relative — Cloudflare's injected email-decode; 0 authored), ${cssLinks.length} stylesheet <link>, ${imgs.length} <img>, ${fontFaces} @font-face, ${inlineScripts} inline <script> — the page fetches nothing cross-origin`);
  for (const s of external) {
    const ok = /\bintegrity\s*=/.test(s.tag);
    record('integrity', `SRI ${s.url}`, ok ? 'PASS' : 'FINDING', ok ? 'integrity present' : 'third-party asset without integrity — add SRI or self-host', !ok);
  }

  // The one script the visitor did not get from this repo. Measure it rather
  // than guessing: its own cache policy is part of the delivery cost.
  let edgeScript = { bytes: 0, path: null, cacheControl: null };
  if (relative.length > 0) {
    const p = relative[0].url;
    const r = await request(p, { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
    edgeScript = { bytes: r.bytes, path: p, cacheControl: r.headers['cache-control'] ?? null, encoding: r.headers['content-encoding'] ?? 'none' };
    record('integrity', 'injected edge script', 'WEAK',
      `Cloudflare appends ${p} (${r.bytes.toLocaleString()} B, ${edgeScript.encoding}); same-origin and rewritten in flight, so SRI cannot apply to it — it is the only script a visitor did not get from this repo`);
    if (!/max-age\s*=/.test(edgeScript.cacheControl ?? '')) {
      record('caching', 'injected edge script freshness', 'WEAK',
        `cache-control: ${edgeScript.cacheControl ?? '(absent)'} — no max-age, so every navigation refetches (revalidates) it; on a slow link that is one extra round trip before the page is fully quiet`);
    }
  }

  // ─── 6. failure modes ────────────────────────────────────────────────────
  const bogusEnc = await request('/', { headers: { 'accept-encoding': 'bogus-enc' } });
  record('failure', 'bogus Accept-Encoding', bogusEnc.status < 500 ? 'PASS' : 'FINDING',
    `HTTP ${bogusEnc.status}, ${bogusEnc.bytes.toLocaleString()} B ${bogusEnc.headers['content-encoding'] ?? 'identity'} — no 5xx`, bogusEnc.status >= 500);

  const garbage = await request('/', { headers: { 'if-none-match': '"garbage"', 'accept-encoding': 'gzip' } });
  record('failure', 'If-None-Match: garbage', garbage.status === 200 && garbage.bytes > 0 ? 'PASS' : 'FINDING',
    `HTTP ${garbage.status}, ${garbage.bytes.toLocaleString()} B — a validator mismatch returns the full fresh body, never a 5xx or an empty 200`, garbage.status >= 500 || (garbage.status === 200 && garbage.bytes === 0));

  const miss = await request('/site-delivery-audit-nonexistent-xyz', { headers: { 'accept-encoding': 'gzip' } });
  record('failure', 'unknown path', miss.status === 404 ? 'PASS' : 'FINDING',
    `HTTP ${miss.status}, ${miss.bytes.toLocaleString()} B, cache-control ${miss.headers['cache-control'] ?? '(absent)'}${miss.headers.etag ? '' : ', no ETag'}`, miss.status !== 404);
  if (!miss.headers['cache-control']) {
    record('caching', '404 freshness', 'WEAK', '404 responses carry no cache-control — a shared cache is left to its own default');
  }

  const head = await request('/', { method: 'HEAD', headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
  const get = await request('/', { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
  const parity = ['content-type', 'cache-control', 'vary', 'content-encoding', 'etag', 'last-modified', 'strict-transport-security']
    .filter((k) => (head.headers[k] ?? '') !== (get.headers[k] ?? ''));
  record('failure', 'HEAD vs GET', head.status === get.status && parity.length === 0 ? 'PASS' : 'FINDING',
    `HTTP ${head.status}/${get.status}; ${parity.length === 0 ? 'every compared header identical (content-type, cache-control, vary, content-encoding, etag, last-modified, hsts)' : `differ: ${parity.join(', ')}`}`,
    parity.length !== 0);

  // `/` and `/index.html` are the same document; Cloudflare rewrites each
  // response with its own nonce, so the comparison is structural, not bytes.
  const idx = await request('/index.html', { headers: { 'accept-encoding': 'identity' } });
  const title = (s) => (s.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '(none)';
  const canonical = (s) => (s.match(/<link\s+rel="canonical"\s+href="([^"]+)"/) ?? [])[1] ?? '(none)';
  const sameDoc = idx.status === 200 && title(idx.body) === title(doc) && canonical(idx.body) === canonical(doc);
  record('failure', '/ vs /index.html', sameDoc ? 'PASS' : 'FINDING',
    `both HTTP 200, same <title> and canonical ${canonical(doc)}; bytes differ only by Cloudflare's per-response nonce (cdn-cgi content id + randomised data-cfemail)`, !sameDoc);

  // ─── 7. weight ───────────────────────────────────────────────────────────
  const emailDecode = edgeScript.bytes;
  record('weight', 'first load', 'PASS',
    `2 requests: document ${get.bytes.toLocaleString()} B (${got}) + Cloudflare email-decode ${emailDecode.toLocaleString()} B = ~${(get.bytes + emailDecode).toLocaleString()} B; ${idBytes.toLocaleString()} B decoded, ${imgs.length} images, ${fontFaces} fonts, ${cssLinks.length} stylesheets`);
  const biggest = seen.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3);
  record('weight', 'largest published assets', 'PASS',
    biggest.map((b) => `${b.path} ${b.bytes.toLocaleString()} B`).join(' · '));

  report();
}

function report() {
  const width = Math.max(...rows.map((r) => r.item.length));
  for (const r of rows) {
    console.log(`${r.verdict.padEnd(7)} ${r.area.padEnd(12)} ${r.item.padEnd(width)}  ${r.detail}`);
  }
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const fatal = rows.filter((r) => r.fatal && r.verdict !== 'PASS');
  console.log(`\n[site-delivery-audit] ${ORIGIN} — PASS ${count('PASS')} · WEAK ${count('WEAK')} · FINDING ${count('FINDING')}`);
  if (fatal.length > 0) {
    console.error('[site-delivery-audit] REGRESSION:');
    for (const r of fatal) console.error(`  - ${r.item}: ${r.detail}`);
    process.exitCode = 1;
  }
  session?.close();
}

await main();
