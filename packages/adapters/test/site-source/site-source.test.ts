import { gzipSync } from 'node:zlib';
import { checkMigrationSource, type MigrationSourceInput } from '@contentworker/domain';
import type { DiscoveredPage } from '@contentworker/ports';
import { FakeRemoteFetcher } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import {
  createSiteSource,
  DEFAULT_SITE_USER_AGENT,
  SITE_PAGE_MAX_BYTES,
} from '../../src/site-source';

const O = 'https://site.test';
const html = (body: string) => ({ contentType: 'text/html; charset=utf-8', body });
const urlset = (...locs: string[]) =>
  `<urlset>${locs.map((l) => `<url><loc>${l}</loc><lastmod>2026-02-01</lastmod></url>`).join('')}</urlset>`;

async function discover(fetcher: FakeRemoteFetcher, input: MigrationSourceInput, waits?: number[]) {
  const source = checkMigrationSource(input);
  const pages: DiscoveredPage[] = [];
  const report = await createSiteSource(fetcher, {
    wait: async (ms) => {
      waits?.push(ms);
    },
  }).discover(source, async (p) => {
    pages.push(p);
  });
  return { pages, report };
}

describe('site source: sitemaps', () => {
  it('reads the sitemaps robots.txt names for an origin, through an index, gzip and all', async () => {
    const fetcher = new FakeRemoteFetcher({
      [`${O}/robots.txt`]: {
        body: `User-agent: *\nDisallow: /private\nSitemap: ${O}/index.xml\nSitemap: https://cdn.test/s.xml`,
      },
      [`${O}/index.xml`]: {
        body: `<sitemapindex><sitemap><loc>${O}/pages.xml.gz</loc></sitemap><sitemap><loc>https://other.test/x.xml</loc></sitemap></sitemapindex>`,
      },
      [`${O}/pages.xml.gz`]: {
        contentType: 'application/gzip',
        body: new Uint8Array(
          gzipSync(
            urlset(
              `${O}/`,
              `${O}/about#team`,
              `${O}/about?ref=x`,
              `${O}/private/a`,
              'https://other.test/page',
              'not a url',
            ),
          ),
        ),
      },
    });
    const { pages, report } = await discover(fetcher, { kind: 'sitemap', url: O });
    expect(pages).toEqual([
      { url: `${O}/`, lastModified: '2026-02-01' },
      { url: `${O}/about`, lastModified: '2026-02-01' },
    ]);
    expect(report).toEqual({
      discovered: 5,
      skipped: { robots: 1, filtered: 0, offOrigin: 1, overLimit: 0, invalid: 1 },
      warnings: [
        'robots.txt names a sitemap on another origin, left: https://cdn.test/s.xml',
        'a sitemap index names a sitemap on another origin, left: https://other.test/x.xml',
      ],
    });
    // Only the origin was asked anything, as ContentWorker.
    expect(fetcher.requests.map((r) => r.url)).toEqual([
      `${O}/robots.txt`,
      `${O}/index.xml`,
      `${O}/pages.xml.gz`,
    ]);
    expect(new Set(fetcher.requests.map((r) => r.options.userAgent))).toEqual(
      new Set([DEFAULT_SITE_USER_AGENT]),
    );
  });

  it('falls back to /sitemap.xml, applies the globs and stops at maxPages', async () => {
    const fetcher = new FakeRemoteFetcher({
      [`${O}/sitemap.xml`]: {
        body: urlset(
          `${O}/blog/a`,
          `${O}/blog/b`,
          `${O}/blog/drafts/c`,
          `${O}/shop`,
          `${O}/blog/d`,
        ),
      },
    });
    const { pages, report } = await discover(fetcher, {
      kind: 'sitemap',
      url: `${O}/`,
      include: ['/blog/**'],
      exclude: ['/blog/drafts/**'],
      maxPages: 2,
    });
    expect(pages.map((p) => p.url)).toEqual([`${O}/blog/a`, `${O}/blog/b`]);
    expect(report.skipped).toMatchObject({ filtered: 2, overLimit: 1 });
  });

  it('says why when there is nothing to read', async () => {
    const fetcher = new FakeRemoteFetcher();
    const { pages, report } = await discover(fetcher, {
      kind: 'sitemap',
      url: `${O}/sitemap_index.xml`,
    });
    expect(pages).toEqual([]);
    expect(report.warnings).toEqual([`sitemap ${O}/sitemap_index.xml answered 404`]);
  });

  it('fetches nothing while robots.txt answers a server error', async () => {
    const fetcher = new FakeRemoteFetcher({
      [`${O}/robots.txt`]: { status: 503 },
      [`${O}/sitemap.xml`]: { body: urlset(`${O}/a`) },
    });
    const { pages, report } = await discover(fetcher, { kind: 'sitemap', url: `${O}/sitemap.xml` });
    expect(pages).toEqual([]);
    expect(report.skipped.robots).toBe(1);
    expect(report.warnings[0]).toMatch(/robots\.txt answered 503/);
  });
});

describe('site source: crawl', () => {
  const site = () =>
    new FakeRemoteFetcher({
      [`${O}/robots.txt`]: { body: 'User-agent: *\nDisallow: /admin' },
      [`${O}/`]: html(
        `<nav><a href="/blog">Blog</a><a href="/admin/x">Admin</a><a href="https://other.test/">x</a><a href="/logo.png">l</a><a href="#top">t</a></nav>`,
      ),
      [`${O}/blog`]: html(
        `<a href="/blog/one?utm=1">1</a><a href="blog/two">2</a><a href="/old">o</a>`,
      ),
      [`${O}/blog/one`]: html('<p>one</p><a href="/">home</a>'),
      [`${O}/blog/two`]: { contentType: 'application/pdf', body: '%PDF' },
      [`${O}/old`]: { status: 301 },
    });

  it('walks same-origin links, hands over the HTML it fetched, and leaves the rest', async () => {
    const fetcher = site();
    const { pages, report } = await discover(fetcher, { kind: 'crawl', url: `${O}/` });
    expect(pages.map((p) => [p.url, p.fetched?.status])).toEqual([
      [`${O}/`, 200],
      [`${O}/blog`, 200],
      [`${O}/blog/one`, 200],
    ]);
    expect(pages[2]?.fetched?.html).toContain('<p>one</p>');
    expect(report.skipped).toEqual({
      robots: 1,
      filtered: 0,
      offOrigin: 1,
      overLimit: 0,
      invalid: 0,
    });
    const asked = fetcher.requests.map((r) => r.url);
    expect(asked).not.toContain(`${O}/admin/x`);
    expect(asked).not.toContain(`${O}/logo.png`);
    expect(asked).not.toContain('https://other.test/');
    // Each page once.
    expect(asked.filter((u) => u === `${O}/`).length).toBe(1);
  });

  it('fetches pages outside include for their links, not excluded ones, up to maxPages', async () => {
    const fetcher = site();
    const { pages, report } = await discover(fetcher, {
      kind: 'crawl',
      url: `${O}/`,
      include: ['/blog/*'],
      exclude: ['/old'],
      maxPages: 1,
    });
    expect(pages.map((p) => p.url)).toEqual([`${O}/blog/one`]);
    expect(report.skipped.filtered).toBeGreaterThanOrEqual(3);
    expect(fetcher.requests.map((r) => r.url)).not.toContain(`${O}/old`);
  });

  it('keeps to the crawl delay robots.txt asks, one request at a time', async () => {
    const fetcher = site();
    fetcher.set(`${O}/robots.txt`, { body: 'User-agent: ContentWorker\nCrawl-delay: 1.5' });
    const waits: number[] = [];
    await discover(fetcher, { kind: 'crawl', url: `${O}/` }, waits);
    expect(waits.length).toBeGreaterThan(0);
    expect(new Set(waits)).toEqual(new Set([1500]));
  });

  it('says so when the start page does not answer with HTML', async () => {
    const fetcher = site();
    const { pages, report } = await discover(fetcher, { kind: 'crawl', url: `${O}/old` });
    expect(pages).toEqual([]);
    expect(report.warnings).toEqual([`the start page ${O}/old answered 301`]);
  });
});

describe('site source: fetching pages', () => {
  it('answers each page, never throwing for one', async () => {
    const fetcher = new FakeRemoteFetcher({
      [`${O}/robots.txt`]: { body: 'User-agent: *\nDisallow: /secret' },
      [`${O}/a`]: html('<h1>A</h1>'),
      [`${O}/b`]: { status: 500 },
      [`${O}/c`]: { contentType: 'image/png', body: 'png' },
      [`${O}/d`]: () => {
        throw new Error('timed out');
      },
      [`${O}/e`]: { body: '<!doctype html><p>no type</p>' },
    });
    const source = checkMigrationSource({ kind: 'sitemap', url: O });
    const pages = await createSiteSource(fetcher).fetchPages(source, [
      `${O}/a`,
      `${O}/b`,
      `${O}/c`,
      `${O}/d`,
      `${O}/e`,
      `${O}/secret/x`,
      'https://other.test/a',
    ]);
    expect(pages.map((p) => [p.status, p.error ?? p.html])).toEqual([
      [200, '<h1>A</h1>'],
      [500, 'answered 500'],
      [200, 'not HTML (image/png)'],
      [0, 'timed out'],
      [200, '<!doctype html><p>no type</p>'],
      [0, 'disallowed by robots.txt'],
      [0, 'not on the source origin'],
    ]);
    // robots.txt once for the batch; pages bounded.
    expect(fetcher.requests.filter((r) => r.url.endsWith('/robots.txt')).length).toBe(1);
    expect(fetcher.requests.find((r) => r.url === `${O}/a`)?.options.maxBytes).toBe(
      SITE_PAGE_MAX_BYTES,
    );
  });
});
