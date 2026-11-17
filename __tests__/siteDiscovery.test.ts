// Copyright © 2026 baocommunity — licenced under AGPL-3.0 (see LICENSE.txt).

/**
 * Discovery completeness of court.bao.network (`site/`), asserted from the repo.
 *
 * The host's whole reason to exist is that a machine can find out what the ₿AO
 * Court is: the head has to advertise a canonical URL and a preview image, the
 * crawl files have to exist and agree with each other, and every internal link
 * has to resolve to a file that actually ships. None of that is exercised by a
 * byte comparison against the live host (`scripts/check-live-site.mjs`), because
 * Cloudflare rewrites the HTML in flight — so it is asserted here, structurally,
 * against the repo copy. `docs/DISCOVERY_AUDIT.md` is the narrative.
 *
 * Deliberately dependency-free: regex over the shipped bytes, no jsdom, no XML
 * library. Every assertion below is a property an agent or crawler relies on,
 * not a lint rule for its own sake.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FILES } from '../scripts/check-live-site.mjs';

const SITE = 'site';
const ORIGIN = 'https://court.bao.network';

const read = (rel: string): Buffer => readFileSync(`${SITE}/${rel}`);
const text = (rel: string): string => read(rel).toString('utf8');

/** The document as a crawler sees the semantics: comments, <style> and <script> bodies removed. */
function markupOnly(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');
}

/** One `<meta>`/`<link>` attribute value by name or property, first match. */
function headValue(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const tag = new RegExp(`<(?:meta|link)\\b[^>]*\\b${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'i').exec(html);
  if (!tag) return undefined;
  const value = /\bcontent="([^"]*)"/i.exec(tag[0]) ?? /\bhref="([^"]*)"/i.exec(tag[0]);
  return value?.[1];
}

/** PNG width/height straight out of the IHDR chunk — no image decoder needed. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const indexHtml = text('index.html');
const anchors = [...markupOnly(indexHtml).matchAll(/<a\b([^>]*)>/gi)].map((m) => m[1]);

describe('site/: every published path is the path the live check compares', () => {
  it('lists all eleven documents/assets, each present in this checkout', () => {
    expect(FILES.map(([, path]) => path).sort()).toEqual(
      [
        '/.well-known/llms.txt',
        '/.well-known/security.txt',
        '/apple-touch-icon.png',
        '/favicon-32.png',
        '/favicon.ico',
        '/icon-512.png',
        '/llms.md',
        '/llms.txt',
        '/og.png',
        '/robots.txt',
        '/sitemap.xml',
      ].sort(),
    );
    for (const [file] of FILES) expect(existsSync(file), `${file} is missing`).toBe(true);
  });

  it('ships an HTML fallback for a missing path (GitHub Pages serves 404.html)', () => {
    expect(existsSync(`${SITE}/404.html`)).toBe(true);
  });
});

describe('site/index.html: what an agent reads out of the head', () => {
  it('declares a canonical URL equal to the served URL, and og:url agrees', () => {
    expect(headValue(indexHtml, 'property', 'og:url')).toMatch(/^https:\/\//);
    expect(headValue(indexHtml, 'property', 'og:url')).toBe(`${ORIGIN}/`);
    const canonical = /<link\b[^>]*rel="canonical"[^>]*>/i.exec(indexHtml)?.[0];
    expect(canonical, 'no <link rel="canonical">').toBeDefined();
    expect(/\bhref="([^"]+)"/.exec(canonical!)?.[1]).toBe(`${ORIGIN}/`);
  });

  it('points canonical at an absolute URL with the trailing slash the host serves', () => {
    // GitHub Pages answers both / and /index.html with 200 and does not redirect,
    // so the tag is the only thing that picks one of them.
    expect(headValue(indexHtml, 'property', 'og:url')).not.toMatch(/[^/]$/);
  });

  it('advertises an absolute preview image that exists, at the size it claims', () => {
    const og = headValue(indexHtml, 'property', 'og:image');
    const tw = headValue(indexHtml, 'name', 'twitter:image');
    expect(og).toMatch(/^https:\/\//);
    expect(tw).toBe(og);
    expect(headValue(indexHtml, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(headValue(indexHtml, 'property', 'og:image:alt')).toMatch(/\S/);
    expect(headValue(indexHtml, 'name', 'twitter:image:alt')).toMatch(/\S/);

    // The declared file is the one in site/ (never a remote or relative path).
    expect(og!.startsWith(`${ORIGIN}/`)).toBe(true);
    const size = pngSize(read(og!.slice(ORIGIN.length + 1)));
    expect(String(size.width)).toBe(headValue(indexHtml, 'property', 'og:image:width'));
    expect(String(size.height)).toBe(headValue(indexHtml, 'property', 'og:image:height'));
    expect(size).toEqual({ width: 1200, height: 630 });
  });

  it('keeps the icon paths crawlers probe without parsing the head', () => {
    expect(/<link\b[^>]*rel="icon"[^>]*type="image\/png"[^>]*href="\/favicon-32\.png"/i.test(indexHtml)).toBe(true);
    expect(/<link\b[^>]*rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/i.test(indexHtml)).toBe(true);
    expect(pngSize(read('favicon-32.png'))).toEqual({ width: 32, height: 32 });
    expect(pngSize(read('apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
    expect(pngSize(read('icon-512.png'))).toEqual({ width: 512, height: 512 });

    // ICO shell: reserved=0, type=1, count>=1, and its payload is our 32x32 PNG.
    const ico = read('favicon.ico');
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
    expect(ico.readUInt8(6)).toBe(32);
    const offset = ico.readUInt32LE(18);
    const payload = ico.subarray(offset, offset + ico.readUInt32LE(14));
    expect(pngSize(payload)).toEqual({ width: 32, height: 32 });
  });

  it('carries a theme-color, a language and a description', () => {
    expect(headValue(indexHtml, 'name', 'theme-color')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(/<html\b[^>]*\blang="en"/i.test(indexHtml)).toBe(true);
    expect(headValue(indexHtml, 'name', 'description')!.length).toBeGreaterThan(80);
    // An agent fetching the page should learn where the markdown lives.
    expect(/<link\b[^>]*rel="alternate"[^>]*type="text\/markdown"[^>]*href="\/llms\.txt"/i.test(indexHtml)).toBe(true);
  });

  it('ships JSON-LD that parses, names this site, and points at the canonical URL', () => {
    const blocks = [...indexHtml.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(blocks.length).toBe(1);
    const data = JSON.parse(blocks[0][1]) as { '@context': string; '@graph': Array<Record<string, unknown>> };
    expect(data['@context']).toBe('https://schema.org');
    const byType = new Map(data['@graph'].map((node) => [node['@type'], node]));
    expect([...byType.keys()].sort()).toEqual(['Organization', 'WebSite']);
    expect(byType.get('WebSite')!.url).toBe(`${ORIGIN}/`);
    expect(byType.get('WebSite')!.inLanguage).toBe('en');
    expect(byType.get('Organization')!.url).toBe(`${ORIGIN}/`);
    // Publisher is a reference, so the two nodes stay one graph rather than two
    // competing ones.
    expect(byType.get('WebSite')!.publisher).toEqual({ '@id': `${ORIGIN}/#publisher` });
    expect(byType.get('Organization')!['@id']).toBe(`${ORIGIN}/#publisher`);
  });
});

describe('site/index.html: document structure and links', () => {
  // The outline itself (one <h1> on the nameplate, no skipped levels) is owned
  // by `__tests__/siteLanding.test.ts`; this file only covers what a crawler
  // resolves — link targets and hosts.

  it('every root-relative href resolves to a file that ships', () => {
    // Anchors on this page are external or in-page fragments; the root-relative
    // hrefs are the head's own discovery links (llms.txt, the icons). Both
    // groups have to resolve, and a typo in either is a silent 404 for an agent.
    const internal = [...markupOnly(indexHtml).matchAll(/\bhref="(\/[^"]*)"/gi)]
      .map((m) => m[1])
      .filter((href) => !href.startsWith('//'));
    expect(internal.length).toBeGreaterThan(0);
    expect(internal).toContain('/llms.txt');
    for (const href of internal) {
      const rel = href.split('#')[0].split('?')[0].slice(1);
      expect(existsSync(`${SITE}/${rel}`), `${href} has no file at site/${rel}`).toBe(true);
    }
  });

  it('every new-tab link carries rel="noopener"', () => {
    const blank = anchors.filter((attrs) => /\btarget="_blank"/i.test(attrs));
    expect(blank.length).toBeGreaterThan(0);
    for (const attrs of blank) expect(/\brel="[^"]*\bnoopener\b/i.test(attrs), attrs.slice(0, 80)).toBe(true);
  });

  it('has no link to a host that does not resolve, and labels the legacy host', () => {
    const hosts = new Set(
      anchors
        .map((attrs) => /https?:\/\/([^/"]+)/.exec(attrs)?.[1])
        .filter((host): host is string => !!host),
    );
    // Every external host the page links to is one of these known-live surfaces.
    expect([...hosts].sort()).toEqual(
      ['bao.bao.network', 'bao.markets', 'bao.network', 'court.bao.network', 'fund.bao.network', 'github.com'].sort(),
    );
    // bao.network is the legacy host: the discovery brief must say so rather
    // than present it as the canonical home.
    expect(text('llms.txt')).toMatch(/legacy network host/);
  });
});

describe('crawl files', () => {
  it('llms.txt, llms.md and /.well-known/llms.txt are byte-identical', () => {
    const a = createHash('sha256').update(read('llms.txt')).digest('hex');
    expect(createHash('sha256').update(read('llms.md')).digest('hex')).toBe(a);
    expect(createHash('sha256').update(read('.well-known/llms.txt')).digest('hex')).toBe(a);
  });

  it('llms.txt names no version number that can go stale silently', () => {
    // It claimed "v0.7.2 at the time of writing" while the package was 0.17.2.
    expect(text('llms.txt')).not.toMatch(/\bv\d+\.\d+\.\d+\b/);
  });

  it('robots.txt points at the sitemap and allows every discovery document', () => {
    const robots = text('robots.txt');
    expect(robots).toMatch(/^Sitemap: https:\/\/court\.bao\.network\/sitemap\.xml$/m);
    expect(robots).toMatch(/^User-agent: \*$/m);
    for (const path of [
      '/llms.txt',
      '/llms.md',
      '/.well-known/llms.txt',
      '/.well-known/security.txt',
      '/sitemap.xml',
    ]) {
      expect(robots).toMatch(new RegExp(`^Allow: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
    // The reservation on everything else must survive: this file is the licence
    // position, not just a crawler hint.
    expect(robots).toMatch(/^Disallow: \/$/m);
    expect(robots).toMatch(/^Content-Signal: search=yes, ai-train=no, use=reference$/m);
  });

  it('sitemap.xml is well formed and lists every public HTML path', () => {
    const xml = text('sitemap.xml');
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml.match(/<urlset\b/g)).toHaveLength(1);
    expect(xml.match(/<\/urlset>/g)).toHaveLength(1);
    expect(xml).toMatch(/xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(loc.startsWith(`${ORIGIN}/`)).toBe(true);
      const rel = loc.slice(ORIGIN.length + 1) || 'index.html';
      expect(existsSync(`${SITE}/${rel}`), `${loc} has no file at site/${rel}`).toBe(true);
    }
    // The landing page is the only HTML document this host serves.
    const htmlFiles = FILES.map(([file]) => file).filter((f) => f.endsWith('.html'));
    expect(htmlFiles).toEqual([]); // index.html is not in the live check (Cloudflare rewrites it)
    expect(locs).toContain(`${ORIGIN}/`);
  });

  it('security.txt has a Contact, a Canonical and an Expires that has not passed', () => {
    const fields = new Map(
      text('.well-known/security.txt')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at), line.slice(at + 1).trim()] as const;
        }),
    );
    expect(fields.get('Contact')).toMatch(/^https:\/\/|^mailto:/);
    expect(fields.get('Canonical')).toBe(`${ORIGIN}/.well-known/security.txt`);
    expect(fields.get('Policy')).toMatch(/^https:\/\//);
    expect(fields.has('Preferred-Languages')).toBe(true);

    const expires = Date.parse(fields.get('Expires') ?? '');
    expect(Number.isNaN(expires)).toBe(false);
    const now = Date.now();
    // RFC 9116: in the future, and SHOULD be less than a year out. The upper
    // bound is what forces someone to look at this file again.
    expect(expires).toBeGreaterThan(now);
    expect(expires - now).toBeLessThan(366 * 24 * 60 * 60 * 1000);
  });
});

describe('site/404.html', () => {
  const notFound = text('404.html');

  it('is a real document: one h1, noindex, and a way home', () => {
    expect(/<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(notFound)).toBe(true);
    expect([...markupOnly(notFound).matchAll(/<h1\b/gi)]).toHaveLength(1);
    expect(notFound).toMatch(/href="https:\/\/court\.bao\.network\/"/);
    expect(notFound).toMatch(/href="https:\/\/court\.bao\.network\/llms\.txt"/);
    expect(notFound).toMatch(/<html\b[^>]*\blang="en"/i);
  });

  it('loads nothing from anywhere (it is served on every miss)', () => {
    const markup = markupOnly(notFound);
    expect(markup).not.toMatch(/<script\b/i);
    expect(markup).not.toMatch(/<img\b/i);
    expect(markup).not.toMatch(/@font-face/i);
    // Styles are inline; the only hrefs are same-origin documents.
    for (const href of [...markup.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) {
      if (href.startsWith('#') || href.endsWith('.png') || href.endsWith('.ico')) continue;
      expect(href.startsWith(`${ORIGIN}/`) || href.startsWith('https://github.com/'), href).toBe(true);
    }
  });
});
