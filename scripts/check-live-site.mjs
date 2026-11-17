#!/usr/bin/env node
/**
 * check-live-site.mjs — does https://court.bao.network serve THIS repo's site/?
 *
 * The landing page is deployed from `site/` by hand, so the repo can say one
 * thing and the host another with nothing to notice. This compares bytes, per
 * path, with a cache-busting retry so an edge cache is not reported as drift.
 *
 *   node scripts/check-live-site.mjs
 *   COURT_LIVE_ATTEMPTS=1 node scripts/check-live-site.mjs   # no retry
 *
 * Exit 1 lists every mismatch. No secrets, no auth: these are public pages.
 *
 * WHAT IS DELIBERATELY NOT COMPARED
 *
 * `index.html` and `404.html` are HTML, and Cloudflare rewrites HTML in flight
 * (a hidden bot-management anchor, `__cf_email__` obfuscation, the email-decode
 * script), so a byte comparison there would fail on a perfectly current
 * deployment. What those two files *claim* — canonical, og:image, JSON-LD,
 * sitemap coverage — is asserted structurally in
 * `__tests__/siteDiscovery.test.ts` instead, against the repo copy AND the live
 * copy, so weakening the head is still caught.
 *
 * EVERYTHING ELSE IS COMPARED, binaries included: the comparison reads Buffers
 * on both sides (a utf8 read corrupts the OG/favicon bytes), which is why the
 * asset paths can sit in the same table as the text documents.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ORIGIN = process.env.COURT_LIVE_ORIGIN ?? 'https://court.bao.network';
const ATTEMPTS = Number(process.env.COURT_LIVE_ATTEMPTS ?? 3);
const RETRY_MS = Number(process.env.COURT_LIVE_RETRY_MS ?? 5000);
const TIMEOUT_MS = Number(process.env.COURT_LIVE_TIMEOUT_MS ?? 15000);

// [file in this repo, path on the host]
//
// Exported so `__tests__/siteDiscovery.test.ts` can assert the same table: a
// path that is published but not compared (or vice versa) is exactly the drift
// this file exists to catch, and two hand-maintained lists would drift apart.
export const FILES = [
  // The three copies of the agent brief must stay byte-identical to each other
  // AND to the host; all three are listed so a one-sided edit is caught.
  ['site/llms.txt', '/llms.txt'],
  ['site/llms.md', '/llms.md'],
  ['site/.well-known/llms.txt', '/.well-known/llms.txt'],
  ['site/robots.txt', '/robots.txt'],
  ['site/sitemap.xml', '/sitemap.xml'],
  ['site/.well-known/security.txt', '/.well-known/security.txt'],
  // Preview/social and icon assets. Binary, compared as bytes.
  ['site/og.png', '/og.png'],
  ['site/icon-512.png', '/icon-512.png'],
  ['site/apple-touch-icon.png', '/apple-touch-icon.png'],
  ['site/favicon-32.png', '/favicon-32.png'],
  // The conventional path agents and old Safari probe without reading the head.
  ['site/favicon.ico', '/favicon.ico'],
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(path) {
  const url = `${ORIGIN}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'cache-control': 'no-cache' },
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, type: res.headers.get('content-type') ?? '' };
}

/** Content type each document must come back as; a text/plain 404 body would still hash-match nothing, but a wrong type breaks agents that sniff. */
const EXPECTED_TYPE = [
  [/^\/llms\.txt$/, /^text\/plain/],
  [/^\/llms\.md$/, /^text\/(markdown|plain)/],
  [/^\/\.well-known\/llms\.txt$/, /^text\/plain/],
  [/^\/robots\.txt$/, /^text\/plain/],
  [/^\/sitemap\.xml$/, /^(application|text)\/xml/],
  [/^\/\.well-known\/security\.txt$/, /^text\/plain/],
  [/^\/og\.png$/, /^image\/png/],
  [/^\/icon-512\.png$/, /^image\/png/],
  [/^\/apple-touch-icon\.png$/, /^image\/png/],
  [/^\/favicon-32\.png$/, /^image\/png/],
  [/^\/favicon\.ico$/, /^image\/(x-icon|vnd\.microsoft\.icon)/],
];

export const expectType = (path, got) => EXPECTED_TYPE.filter(([p]) => p.test(path)).every(([, t]) => t.test(got));

export async function main() {
  const failures = [];
  let checked = 0;

  for (const [file, path] of FILES) {
    const expected = await readFile(file);
    const want = sha256(expected);
    let last = 'no attempt';
    let ok = false;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const { status, bytes, type } = await fetchOnce(path);
        const got = sha256(bytes);
        if (status === 200 && got === want && expectType(path, type)) {
          console.log(`[check-live-site] OK ${path} (${want.slice(0, 12)}…)`);
          ok = true;
          break;
        }
        last = `HTTP ${status}, content-type "${type}", sha256 ${got.slice(0, 12)}… (${bytes.length} B), expected ${want.slice(0, 12)}… (${expected.length} B)`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (attempt < ATTEMPTS) await sleep(RETRY_MS);
    }

    checked += 1;
    if (!ok) failures.push(`${path} (from ${file}): ${last}`);
  }

  if (failures.length > 0) {
    console.error(`[check-live-site] FAILED: ${ORIGIN} is not serving this repo's site/`);
    for (const line of failures) console.error(`  - ${line}`);
    console.error('Republish: .github/workflows/pages.yml deploys site/ to GitHub Pages on every push to main — check that run for the target commit, re-run it, then re-check.');
    process.exit(1);
  }

  console.log(`[check-live-site] OK: ${checked} path(s) on ${ORIGIN} match this checkout`);
}

// Run only when executed (`node scripts/check-live-site.mjs`), never on import:
// the test suite imports FILES/expectType from this module.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
