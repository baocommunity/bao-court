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
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ORIGIN = process.env.COURT_LIVE_ORIGIN ?? 'https://court.bao.network';
const ATTEMPTS = Number(process.env.COURT_LIVE_ATTEMPTS ?? 3);
const RETRY_MS = Number(process.env.COURT_LIVE_RETRY_MS ?? 5000);
const TIMEOUT_MS = Number(process.env.COURT_LIVE_TIMEOUT_MS ?? 15000);

// [file in this repo, path on the host]
//
// index.html is deliberately NOT compared: Cloudflare rewrites it in flight
// (empty body anchor, __cf_email__ obfuscation, email-decode script), so a byte
// comparison of the HTML would fail on a perfectly current deployment. The
// documents below pass through untouched, and they are what agents read.
const FILES = [
  ['site/llms.txt', '/llms.txt'],
  ['site/llms.md', '/llms.md'],
  ['site/.well-known/llms.txt', '/.well-known/llms.txt'],
  ['site/robots.txt', '/robots.txt'],
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(path) {
  const url = `${ORIGIN}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'cache-control': 'no-cache' },
  });
  const body = await res.text();
  return { status: res.status, body };
}

/**
 * Cloudflare's "Content Signals" / managed-robots feature REPLACES /robots.txt at
 * the edge, so the host serves a generic policy instead of the one in site/.
 * That is not drift a redeploy can fix: it is a zone setting. Classify it
 * explicitly so the six-hourly job says what to change instead of "mismatch".
 */
function isCloudflareManagedRobots(body) {
  return /^# As a condition of accessing this website, you agree to abide by the following/i.test(
    body.trimStart(),
  );
}

async function main() {
  const failures = [];
  let checked = 0;

  for (const [file, path] of FILES) {
    const expected = await readFile(file, 'utf8');
    const want = sha256(expected);
    let last = 'no attempt';
    let ok = false;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const { status, body } = await fetchOnce(path);
        const got = sha256(body);
        if (status === 200 && got === want) {
          console.log(`[check-live-site] OK ${path} (${want.slice(0, 12)}…)`);
          ok = true;
          break;
        }
        if (path === '/robots.txt' && isCloudflareManagedRobots(body)) {
          // Not drift a redeploy can fix: the zone replaces robots.txt at the edge.
          if (process.env.COURT_ALLOW_CF_ROBOTS === '1') {
            console.log(`[check-live-site] WARN ${path} is Cloudflare-managed (Content Signals); accepted via COURT_ALLOW_CF_ROBOTS=1`);
            ok = true;
            break;
          }
          last =
            'served by CLOUDFLARE (Content Signals policy), not by this repo — ' +
            'disable the zone\'s managed robots.txt, or set COURT_ALLOW_CF_ROBOTS=1 to accept the divergence';
          break;
        }
        last = `HTTP ${status}, sha256 ${got.slice(0, 12)}… (${body.length} B), expected ${want.slice(0, 12)}… (${expected.length} B)`;
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
    if (failures.some((f) => f.includes('CLOUDFLARE'))) {
      console.error('Note: /robots.txt is replaced by Cloudflare\'s managed Content Signals policy — that is a zone setting, not a deploy.');
    }
    process.exit(1);
  }

  console.log(`[check-live-site] OK: ${checked} path(s) on ${ORIGIN} match this checkout`);
}

await main();
