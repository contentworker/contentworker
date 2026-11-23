/**
 * Reading a sitemap (sitemaps.org protocol): a `urlset` lists pages, a `sitemapindex` lists more
 * sitemaps. Lenient: namespaces, CDATA and the five XML entities are understood, anything else
 * in an entry is ignored, and a file that is neither yields nothing rather than an error.
 */

/** Most entries read from one sitemap file (the protocol's own cap). */
export const SITEMAP_MAX_ENTRIES = 50_000;

export interface SitemapEntry {
  readonly loc: string;
  readonly lastmod?: string;
}

export interface ParsedSitemap {
  /** Further sitemaps, from a sitemap index. */
  readonly sitemaps: SitemapEntry[];
  /** Pages, from a urlset. */
  readonly urls: SitemapEntry[];
}

export function parseSitemapXml(xml: string): ParsedSitemap {
  return { sitemaps: entries(xml, 'sitemap'), urls: entries(xml, 'url') };
}

function entries(xml: string, element: 'url' | 'sitemap'): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${element}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${element}\\s*>`,
    'gi',
  );
  for (const match of xml.matchAll(pattern)) {
    if (out.length >= SITEMAP_MAX_ENTRIES) break;
    const body = match[1] as string;
    const loc = child(body, 'loc');
    if (!loc) continue;
    const lastmod = child(body, 'lastmod');
    out.push(lastmod ? { loc, lastmod } : { loc });
  }
  return out;
}

function child(body: string, name: string): string | undefined {
  const match = new RegExp(
    `<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}\\s*>`,
    'i',
  ).exec(body);
  if (!match) return undefined;
  const raw = (match[1] as string).trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  const text = (cdata ? (cdata[1] as string) : decodeXml(raw)).trim();
  return text || undefined;
}

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    const lower = e.toLowerCase();
    if (named[lower]) return named[lower] as string;
    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}
