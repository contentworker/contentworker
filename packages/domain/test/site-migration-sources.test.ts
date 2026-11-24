import { describe, expect, it } from 'vitest';
import {
  checkMigrationRunInput,
  checkMigrationSource,
  MIGRATION_DEFAULT_MAX_PAGES,
  MIGRATION_MAX_PAGES,
  matchesPathGlob,
  normalizePageUrl,
  parseRobotsTxt,
  parseSitemapXml,
  robotsAllows,
  robotsCrawlDelay,
  sourceTakesPath,
  ValidationError,
} from '../src/index';

describe('a migration source', () => {
  it('fills in its defaults', () => {
    expect(checkMigrationSource({ kind: 'sitemap', url: 'https://Site.test' })).toEqual({
      kind: 'sitemap',
      url: 'https://site.test/',
      include: [],
      exclude: [],
      maxPages: MIGRATION_DEFAULT_MAX_PAGES,
    });
    expect(
      checkMigrationRunInput({
        source: checkMigrationSource({ kind: 'crawl', url: 'https://site.test/a' }),
      }),
    ).toEqual({ name: 'site.test', threshold: 0.8 });
  });

  it('refuses what it cannot use, naming each field', () => {
    const issues = (() => {
      try {
        checkMigrationSource({
          kind: 'feed' as never,
          url: 'ftp://site.test',
          include: ['blog/*'],
          maxPages: MIGRATION_MAX_PAGES + 1,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        return (err as ValidationError).issues.map((i) => i.field);
      }
      return [];
    })();
    expect(issues).toEqual(['source.kind', 'source.url', 'source.maxPages', 'source.include[0]']);
    expect(() =>
      checkMigrationRunInput({
        threshold: 2,
        source: checkMigrationSource({ kind: 'crawl', url: 'https://site.test' }),
      }),
    ).toThrow(ValidationError);
  });

  it('refuses a URL carrying credentials', () => {
    expect(() =>
      checkMigrationSource({ kind: 'crawl', url: 'https://ed:secret@site.test/' }),
    ).toThrow(ValidationError);
  });

  it('matches globs and robots rules in linear time, however many stars', () => {
    const long = `/${'a'.repeat(5_000)}`;
    const started = performance.now();
    expect(matchesPathGlob(long, `/${'a*'.repeat(30)}b`)).toBe(false);
    expect(matchesPathGlob(long, '/**a')).toBe(true);
    expect(
      robotsAllows(parseRobotsTxt(`User-agent: *\nDisallow: /${'*a'.repeat(30)}b$`), long),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(matchesPathGlob('/x/**', '/x/**')).toBe(true);
    expect(matchesPathGlob('/blog/a/b', '/blog/**/b')).toBe(true);
    expect(matchesPathGlob('/blog/b', '/blog/*/b')).toBe(false);
  });

  it('takes paths by include and exclude globs, exclude first', () => {
    const source = checkMigrationSource({
      kind: 'crawl',
      url: 'https://site.test',
      include: ['/blog/**', '/about'],
      exclude: ['/blog/drafts/**', '/blog/*.pdf'],
    });
    expect(sourceTakesPath(source, '/blog/2024/tea')).toBe(true);
    expect(sourceTakesPath(source, '/about')).toBe(true);
    expect(sourceTakesPath(source, '/about/team')).toBe(false);
    expect(sourceTakesPath(source, '/blog/drafts/x')).toBe(false);
    expect(sourceTakesPath(source, '/blog/menu.pdf')).toBe(false);
    expect(matchesPathGlob('/a/b/c', '/a/*/c')).toBe(true);
    expect(matchesPathGlob('/a/b/x/c', '/a/*/c')).toBe(false);
    expect(matchesPathGlob('/a.b', '/a?b')).toBe(false);
  });

  it('knows a page by its URL without fragment or query', () => {
    expect(normalizePageUrl('/tea?utm=1#top', 'https://site.test/blog/')).toBe(
      'https://site.test/tea',
    );
    expect(normalizePageUrl('mailto:a@b.c')).toBeUndefined();
    expect(normalizePageUrl('https://user:pw@site.test/')).toBeUndefined();
  });
});

describe('reading a sitemap', () => {
  it('reads a urlset, with namespaces, CDATA and entities', () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="x">
  <url><loc>https://site.test/a?x=1&amp;y=2</loc><lastmod>2026-01-02</lastmod><image:image><image:loc>https://site.test/i.png</image:loc></image:image></url>
  <url><loc><![CDATA[https://site.test/b]]></loc></url>
  <url><lastmod>2026</lastmod></url>
</urlset>`;
    expect(parseSitemapXml(xml)).toEqual({
      sitemaps: [],
      urls: [
        { loc: 'https://site.test/a?x=1&y=2', lastmod: '2026-01-02' },
        { loc: 'https://site.test/b' },
      ],
    });
  });

  it('reads a sitemap index, prefixed or not', () => {
    const xml = `<sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
<sm:sitemap><sm:loc>https://site.test/posts.xml.gz</sm:loc></sm:sitemap>
<sm:sitemap><sm:loc> https://site.test/pages.xml </sm:loc></sm:sitemap></sm:sitemapindex>`;
    expect(parseSitemapXml(xml).sitemaps.map((s) => s.loc)).toEqual([
      'https://site.test/posts.xml.gz',
      'https://site.test/pages.xml',
    ]);
    expect(parseSitemapXml('<html>not a sitemap</html>')).toEqual({ sitemaps: [], urls: [] });
  });
});

describe('robots.txt', () => {
  const robots = parseRobotsTxt(`
# comment
User-agent: *
Disallow: /private
Allow: /private/press
Disallow: /*.pdf$
Crawl-delay: 2

User-agent: OtherBot
User-agent: contentworker
Disallow: /
Allow: /blog

Sitemap: https://site.test/sitemap.xml
`);

  it('applies the group naming our token, longest rule first', () => {
    expect(robotsAllows(robots, '/blog/tea')).toBe(true);
    expect(robotsAllows(robots, '/about')).toBe(false);
    expect(robotsAllows(robots, '/robots.txt')).toBe(true);
    expect(robots.sitemaps).toEqual(['https://site.test/sitemap.xml']);
  });

  it('falls back to the * group, with patterns, end anchors and the crawl delay', () => {
    expect(robotsAllows(robots, '/private/x', 'SomeBot')).toBe(false);
    expect(robotsAllows(robots, '/private/press/1', 'SomeBot')).toBe(true);
    expect(robotsAllows(robots, '/menu.pdf', 'SomeBot')).toBe(false);
    expect(robotsAllows(robots, '/menu.pdf?x', 'SomeBot')).toBe(true);
    expect(robotsCrawlDelay(robots, 'SomeBot')).toBe(2);
    expect(robotsCrawlDelay(robots)).toBe(0);
    expect(robotsCrawlDelay(parseRobotsTxt('User-agent: *\nCrawl-delay: 120'))).toBe(10);
  });

  it('allows everything when nothing applies, or a disallow is empty', () => {
    expect(robotsAllows(parseRobotsTxt(''), '/x')).toBe(true);
    expect(robotsAllows(parseRobotsTxt('User-agent: *\nDisallow:'), '/x')).toBe(true);
    expect(robotsAllows(parseRobotsTxt('User-agent: *\nDisallow: /caf%C3%A9'), '/café')).toBe(
      false,
    );
  });
});
