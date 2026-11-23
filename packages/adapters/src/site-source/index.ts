import {
  ALLOW_ALL_ROBOTS,
  MIGRATION_CRAWLER_TOKEN,
  type MigrationSource,
  matchesPathGlob,
  normalizePageUrl,
  pageHrefs,
  parseHttpUrl,
  parseRobotsTxt,
  parseSitemapXml,
  type Robots,
  robotsAllows,
  robotsCrawlDelay,
  sourceTakesPath,
} from '@contentworker/domain';
import type {
  DiscoveredPage,
  FetchedPage,
  RemoteFetcher,
  SiteDiscovery,
  SiteSource,
} from '@contentworker/ports';

/**
 * The site source over the outbound fetcher (GET only, no redirects, size- and time-bounded).
 *
 * The caller screens the source URL (the SSRF guard); from there every request this makes stays
 * on that URL's origin: a sitemap entry, a sitemap index child, a robots.txt `Sitemap` line or a
 * link on another origin is counted and left, never fetched. robots.txt is read once per origin
 * and kept to (RFC 9309: unreachable for a server error means nothing may be fetched), and its
 * crawl delay, when it asks one, makes the requests one at a time that far apart.
 */
export interface SiteSourceOptions {
  /** Requests in flight at once, when the site asks no crawl delay. Default 4. */
  readonly concurrency?: number;
  readonly userAgent?: string;
  /** Waits between paced requests; a test passes one that returns at once. */
  readonly wait?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

/** Largest page read. */
export const SITE_PAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Largest sitemap file read, compressed or not (the protocol's own cap is 50 MB uncompressed). */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 512 * 1024;
/** Most sitemap files one discovery reads (an index and its children). */
const MAX_SITEMAP_FILES = 100;
/** Links deep a crawl goes from its start page. */
const MAX_CRAWL_DEPTH = 8;
/** Not pages: a crawl doesn't fetch links to these. */
const NON_PAGE =
  /\.(?:jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tar|docx?|xlsx?|pptx?|mp4|webm|mov|mp3|wav|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|eot)$/i;

export const DEFAULT_SITE_USER_AGENT = `${MIGRATION_CRAWLER_TOKEN}/1.0 (site migration)`;

export function createSiteSource(fetcher: RemoteFetcher, opts: SiteSourceOptions = {}): SiteSource {
  const userAgent = opts.userAgent ?? DEFAULT_SITE_USER_AGENT;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const robotsByOrigin = new Map<string, Promise<{ robots: Robots; warning?: string }>>();

  const robotsFor = (origin: string) => {
    let found = robotsByOrigin.get(origin);
    if (!found) {
      found = readRobots(origin);
      robotsByOrigin.set(origin, found);
    }
    return found;
  };
  const readRobots = async (origin: string): Promise<{ robots: Robots; warning?: string }> => {
    const url = `${origin}/robots.txt`;
    try {
      const res = await fetcher.get(url, { maxBytes: ROBOTS_MAX_BYTES, timeoutMs, userAgent });
      if (res.status >= 200 && res.status < 300) return { robots: parseRobotsTxt(res.body) };
      // No robots.txt (4xx) means no rules; a server error means the site can't say, so nothing.
      if (res.status >= 400 && res.status < 500) return { robots: ALLOW_ALL_ROBOTS };
      return {
        robots: parseRobotsTxt('User-agent: *\nDisallow: /'),
        warning: `${url} answered ${res.status}; nothing is fetched while it can't be read`,
      };
    } catch (err) {
      return {
        robots: parseRobotsTxt('User-agent: *\nDisallow: /'),
        warning: `${url} could not be read (${messageOf(err)}); nothing is fetched`,
      };
    }
  };

  /** Runs `work` over `items`, a few at a time or paced one by one; results in input order. */
  const pooled = async <T, R>(
    items: readonly T[],
    robots: Robots,
    work: (item: T) => Promise<R>,
  ): Promise<R[]> => {
    const delayMs = robotsCrawlDelay(robots) * 1000;
    const out: R[] = [];
    if (delayMs > 0) {
      for (const [i, item] of items.entries()) {
        if (i > 0) await wait(delayMs);
        out.push(await work(item));
      }
      return out;
    }
    for (let at = 0; at < items.length; at += concurrency) {
      out.push(...(await Promise.all(items.slice(at, at + concurrency).map(work))));
    }
    return out;
  };

  const fetchPage = async (url: string): Promise<FetchedPage> => {
    try {
      const res = await fetcher.get(url, { maxBytes: SITE_PAGE_MAX_BYTES, timeoutMs, userAgent });
      const ct = res.contentType ? { contentType: res.contentType } : {};
      if (res.status < 200 || res.status >= 300) {
        // A redirect is a status here, never a hop: the fetcher won't follow one off the origin.
        return { url, status: res.status, ...ct, html: '', error: `answered ${res.status}` };
      }
      if (!isHtml(res.contentType, res.body)) {
        return { url, status: res.status, ...ct, html: '', error: `not HTML (${res.contentType})` };
      }
      return { url, status: res.status, ...ct, html: res.body };
    } catch (err) {
      return { url, status: 0, html: '', error: messageOf(err) };
    }
  };

  return {
    async fetchPages(source, urls) {
      const origin = originOf(source.url);
      const { robots } = await robotsFor(origin);
      return pooled(urls, robots, async (raw): Promise<FetchedPage> => {
        const url = normalizePageUrl(raw);
        if (!url || originOf(url) !== origin) {
          return { url: raw, status: 0, html: '', error: 'not on the source origin' };
        }
        if (!robotsAllows(robots, new URL(url).pathname)) {
          return { url, status: 0, html: '', error: 'disallowed by robots.txt' };
        }
        return fetchPage(url);
      });
    },

    async discover(source, onPage) {
      const origin = originOf(source.url);
      const { robots, warning } = await robotsFor(origin);
      const tally = new Tally(source, origin, robots);
      if (warning) tally.warnings.push(warning);
      if (source.kind === 'sitemap') await discoverSitemaps(source, origin, robots, tally, onPage);
      else await crawl(source, origin, robots, tally, onPage);
      return tally.report();
    },
  };

  async function discoverSitemaps(
    source: MigrationSource,
    origin: string,
    robots: Robots,
    tally: Tally,
    onPage: (page: DiscoveredPage) => Promise<void>,
  ): Promise<void> {
    const start = new URL(source.url);
    const queue: string[] = [];
    if (start.pathname === '/' && !start.search) {
      // The site's origin: the sitemaps its robots.txt names, else the conventional place.
      for (const loc of robots.sitemaps) {
        if (originOf(loc) === origin) queue.push(loc);
        else tally.warnings.push(`robots.txt names a sitemap on another origin, left: ${loc}`);
      }
      if (queue.length === 0) queue.push(`${origin}/sitemap.xml`);
    } else {
      queue.push(source.url);
    }
    const seen = new Set<string>();
    while (queue.length > 0 && !tally.full()) {
      const url = queue.shift() as string;
      if (seen.has(url)) continue;
      if (seen.size >= MAX_SITEMAP_FILES) {
        tally.warnings.push(`stopped after ${MAX_SITEMAP_FILES} sitemap files`);
        break;
      }
      seen.add(url);
      const xml = await readSitemap(url, tally);
      if (xml === undefined) continue;
      const parsed = parseSitemapXml(xml);
      for (const child of parsed.sitemaps) {
        if (originOf(child.loc) === origin) queue.push(child.loc);
        else
          tally.warnings.push(
            `a sitemap index names a sitemap on another origin, left: ${child.loc}`,
          );
      }
      for (const entry of parsed.urls) {
        const url = tally.consider(entry.loc);
        if (url) {
          await onPage(entry.lastmod ? { url, lastModified: entry.lastmod } : { url });
        }
      }
    }
    if (tally.taken === 0 && tally.warnings.length === 0) {
      tally.warnings.push('the sitemap listed no pages');
    }
  }

  async function readSitemap(url: string, tally: Tally): Promise<string | undefined> {
    try {
      const file = await fetcher.getBytes(url, {
        maxBytes: SITEMAP_MAX_BYTES,
        timeoutMs,
        userAgent,
      });
      if (file.status < 200 || file.status >= 300) {
        tally.warnings.push(`sitemap ${url} answered ${file.status}`);
        return undefined;
      }
      const gzipped = file.bytes[0] === 0x1f && file.bytes[1] === 0x8b;
      const bytes = gzipped ? await gunzip(file.bytes, SITEMAP_MAX_BYTES) : file.bytes;
      return new TextDecoder().decode(bytes);
    } catch (err) {
      tally.warnings.push(`sitemap ${url} could not be read (${messageOf(err)})`);
      return undefined;
    }
  }

  async function crawl(
    source: MigrationSource,
    origin: string,
    robots: Robots,
    tally: Tally,
    onPage: (page: DiscoveredPage) => Promise<void>,
  ): Promise<void> {
    const startUrl = normalizePageUrl(source.url) as string;
    tally.discovered = 1;
    if (!robotsAllows(robots, new URL(startUrl).pathname)) {
      tally.skipped.robots += 1;
      tally.warnings.push(`robots.txt disallows the start page ${startUrl}`);
      return;
    }
    // Pages fetched only for their links (outside `include`) count against this budget too: room
    // for a section index or two above the pages wanted, without crawling a whole site for them.
    const maxFetches = source.maxPages * 2 + 100;
    let fetches = 0;
    const queued = new Set([startUrl]);
    let frontier = [startUrl];
    for (let depth = 0; depth <= MAX_CRAWL_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      let done = 0;
      while (done < frontier.length && !tally.full()) {
        if (fetches >= maxFetches) {
          tally.warnings.push(`stopped after ${maxFetches} fetches`);
          return;
        }
        const batch = frontier.slice(done, done + Math.min(concurrency, maxFetches - fetches));
        done += batch.length;
        fetches += batch.length;
        for (const page of await pooled(batch, robots, fetchPage)) {
          if (!page.html) {
            if (page.url === startUrl) {
              tally.warnings.push(`the start page ${page.url} ${page.error ?? 'has no HTML'}`);
            }
            continue;
          }
          if (!sourceTakesPath(source, new URL(page.url).pathname)) tally.skipped.filtered += 1;
          else if (tally.full()) tally.skipped.overLimit += 1;
          else {
            tally.taken += 1;
            await onPage({ url: page.url, fetched: page });
          }
          for (const href of pageHrefs(page.html)) {
            const url = normalizePageUrl(href, page.url);
            if (!url || queued.has(url)) continue;
            queued.add(url);
            const path = new URL(url).pathname;
            if (NON_PAGE.test(path)) continue;
            tally.discovered += 1;
            if (originOf(url) !== origin) tally.skipped.offOrigin += 1;
            // An excluded path isn't fetched; one outside `include` is, for its links.
            else if (source.exclude.some((g) => matchesPathGlob(path, g))) {
              tally.skipped.filtered += 1;
            } else if (!robotsAllows(robots, path)) tally.skipped.robots += 1;
            else next.push(url);
          }
        }
      }
      if (tally.full()) {
        // What was found but not reached.
        tally.skipped.overLimit += frontier.length - done + next.length;
        return;
      }
      frontier = next;
    }
  }
}

/** Counts what a discovery took and left, and decides each sitemap entry. */
class Tally {
  discovered = 0;
  taken = 0;
  readonly skipped = { robots: 0, filtered: 0, offOrigin: 0, overLimit: 0, invalid: 0 };
  readonly warnings: string[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly source: MigrationSource,
    private readonly origin: string,
    private readonly robots: Robots,
  ) {}

  full(): boolean {
    return this.taken >= this.source.maxPages;
  }

  /** The entry's normalized URL when the run takes it; counts why not otherwise. */
  consider(raw: string): string | undefined {
    const url = normalizePageUrl(raw);
    if (url && this.seen.has(url)) return undefined;
    this.discovered += 1;
    if (!url) {
      this.skipped.invalid += 1;
      return undefined;
    }
    this.seen.add(url);
    const path = new URL(url).pathname;
    if (originOf(url) !== this.origin) this.skipped.offOrigin += 1;
    else if (!sourceTakesPath(this.source, path)) this.skipped.filtered += 1;
    else if (!robotsAllows(this.robots, path)) this.skipped.robots += 1;
    else if (this.full()) this.skipped.overLimit += 1;
    else {
      this.taken += 1;
      return url;
    }
    return undefined;
  }

  report(): SiteDiscovery {
    return {
      discovered: this.discovered,
      skipped: { ...this.skipped },
      warnings: [...new Set(this.warnings)].slice(0, 50),
    };
  }
}

const originOf = (url: string): string => parseHttpUrl(url)?.origin ?? '';

function isHtml(contentType: string | undefined, body: string): boolean {
  if (contentType) return /text\/html|application\/xhtml\+xml/i.test(contentType);
  return /^\s*(<!doctype html|<html)/i.test(body.slice(0, 1024));
}

async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`uncompressed sitemap exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
