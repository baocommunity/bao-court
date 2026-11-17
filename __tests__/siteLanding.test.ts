import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Regression lock for the public landing page (court.bao.network).
 *
 * These assertions are the in-repo half of the GUI red-team findings
 * (docs/SITE_SECURITY_HEADERS.md §1): one <h1> per page, a meta CSP that covers
 * exactly what the document loads, and a meta referrer policy. The *header*
 * findings (framing, X-Frame-Options, Permissions-Policy) cannot be closed from
 * a static file on GitHub Pages and are asserted here only as documented-open.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SITE = readFileSync(join(here, '..', 'site', 'index.html'), 'utf8');
const EDGE_DOC = readFileSync(join(here, '..', 'docs', 'SITE_SECURITY_HEADERS.md'), 'utf8');

/**
 * The document with comments and the contents of inline <script>/<style>
 * blocks removed, so a heading or tag mentioned in a comment or inside a
 * vendored bundle cannot satisfy (or break) a markup assertion.
 */
const MARKUP = SITE
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
  .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');


/** `<meta http-equiv="Content-Security-Policy" content="…">` → the policy string. */
function metaCsp(html: string): string | undefined {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  return m?.[1];
}

/** `directive name=value;` list → Map of directive → set of sources. */
function directives(policy: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/).filter(Boolean);
    if (name) out.set(name.toLowerCase(), new Set(values));
  }
  return out;
}

const policy = metaCsp(SITE) ?? '';
const dir = directives(policy);

describe('landing page — document outline', () => {
  it('has exactly one <h1>', () => {
    expect(MARKUP.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('puts the single <h1> on the masthead nameplate', () => {
    expect(MARKUP).toMatch(/<h1 class="nameplate">₿AO COURT<\/h1>/);
  });

  it('demotes the lead headline to <h2>', () => {
    expect(MARKUP).toMatch(/<h2>A <span class="accent">verifiable verdict<\/span> for every dispute\.<\/h2>/);
    expect(MARKUP).not.toMatch(/<h1>A <span class="accent">verifiable/);
  });

  it('styles the lead headline independently of its heading level (visual parity)', () => {
    // The demotion must not change the rendered box: the rule matches either level.
    expect(SITE).toContain('.lead :is(h1, h2) {');
    expect(SITE).toContain(".lead :is(h1, h2) .accent { color: var(--np-accent); }");
  });

  it('never skips a heading level going down the page', () => {
    const levels = [...MARKUP.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      // A deeper jump may only be one level at a time; going back up is free.
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });
});

describe('landing page — meta Content-Security-Policy', () => {
  it('is present', () => {
    expect(policy).not.toBe('');
  });

  it('denies by default and closes base-uri and form-action', () => {
    expect(dir.get('default-src')).toEqual(new Set(["'none'"]));
    expect(dir.get('base-uri')).toEqual(new Set(["'none'"]));
    expect(dir.get('form-action')).toEqual(new Set(["'none'"]));
  });

  it('does not pretend to carry the header-only directives', () => {
    // frame-ancestors / report-uri / report-to / sandbox are IGNORED in a meta
    // element; listing them would emit a console warning and imply protection
    // that does not exist. Framing is closed at the edge (see the edge doc).
    for (const ignored of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
      expect(policy).not.toContain(ignored);
    }
  });

  it("keeps 'self' in script-src for the same-origin Cloudflare email-decode script", () => {
    const scriptSrc = dir.get('script-src');
    expect(scriptSrc?.has("'self'")).toBe(true);
    // The page is a single file: its own code is inline.
    expect(scriptSrc?.has("'unsafe-inline'")).toBe(true);
  });

  it('allows the inline stylesheet and style attributes the theme needs', () => {
    expect(dir.get('style-src')).toEqual(new Set(["'self'", "'unsafe-inline'"]));
  });

  it('allows the data: favicon', () => {
    expect(dir.get('img-src')).toEqual(new Set(["'self'", 'data:']));
  });

  it('allows every origin the page actually calls', () => {
    const api = SITE.match(/var API = '(https:\/\/[^']+)'/)?.[1];
    expect(api).toBeDefined();
    const origin = new URL(api!).origin;
    const connectSrc = [...(dir.get('connect-src') ?? [])];
    expect(connectSrc).toContain(origin);
    // The NWC panel pays through relays named by the user's own connection
    // string, so the websocket origin cannot be pinned.
    expect(connectSrc).toContain('wss:');
  });
});

describe('landing page — loads nothing it does not declare', () => {
  it('has no external <script src> (the policy only needs \'self\' + inline)', () => {
    const external = [...MARKUP.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
    expect(external).toEqual([]);
  });

  it('has no external stylesheet link', () => {
    const external = [...MARKUP.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)];
    expect(external).toEqual([]);
  });

  it('has no remote image, font or media URL in the markup', () => {
    const remote = [...MARKUP.matchAll(/<(?:img|video|audio|source)\b[^>]*\bsrc="https?:/gi)];
    expect(remote).toEqual([]);
    expect(SITE).not.toMatch(/@font-face/);
  });
});

describe('landing page — meta referrer policy', () => {
  it('sets strict-origin-when-cross-origin', () => {
    expect(SITE).toContain('<meta name="referrer" content="strict-origin-when-cross-origin">');
  });
});

describe('edge header rule is documented for the operator', () => {
  it('names every header that only the edge can set', () => {
    for (const header of ['Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy', 'X-Content-Type-Options', 'Permissions-Policy']) {
      expect(EDGE_DOC).toContain(header);
    }
  });

  it('states the framing fix as a header, not as a meta element', () => {
    expect(EDGE_DOC).toContain("frame-ancestors 'none'");
    expect(EDGE_DOC).toContain('X-Frame-Options: DENY');
    expect(EDGE_DOC).toContain('cannot be set by a meta element');
  });

  it('keeps the edge policy at least as permissive as the page needs', () => {
    for (const source of ["default-src 'none'", "script-src 'self' 'unsafe-inline'", 'connect-src \'self\' https://relay.bao.network']) {
      expect(EDGE_DOC).toContain(source);
    }
  });
});
