import {
  ALLOW_ALL_ROBOTS,
  MIGRATION_CRAWLER_TOKEN,
  type MigrationSource,
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
  SiteFetch,
  SiteSource,
} from '@contentworker/ports';

/**
 * The site source over the outbound fetcher (GET only, no redirects, size- and time-bounded).
 *
 * The caller screens the source URL (the SSRF guard); from there every request this makes stays
 * on that URL's origin: a sitemap entry, a sitemap index child, a robots.txt `Sitemap` line or a
 * link on another origin is counted and left, never fetched. robots.txt is read once per origin
 * and kept to. A server error or no answer means the site can't say what may be fetched, so
 * nothing is (RFC 9309) and the caller is told to try again; a 4xx, or a redirect this fetcher
 * won't follow, means there are no rules. When robots.txt asks a crawl delay, every request to
 * the origin after the first (robots.txt included) waits until that long after the one before,
 * across batches and calls, one at a time.
 */
export interface SiteSourceOptions {
  /** Requests in flight at once, when the site asks no crawl delay. Default 4. */
  readonly concurrency?: number;
  readonly userAgent?: string;
  /** Waits between paced requests; a test passes one that returns at once. */
  readonly wait?: (ms: number) => Promise<void>;
  /** Milliseconds now, for pacing; a test passes a fixed one. */
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** Largest page read. */
export const SITE_PAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * Largest sitemap file read, as fetched and as decompressed (the protocol's own cap is 50 MB
 * uncompressed). Decompressed text is decoded as it streams, so no second copy of the bytes is held.
 */
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
const ROBOTS_MAX_BYTES = 512 * 1024;
/** Most sitemap files one discovery reads (an index and its children). */
const MAX_SITEMAP_FILES = 100;
/** Not pages: a crawl doesn't follow links to these. */
const NON_PAGE =
  /\.(?:jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tar|docx?|xlsx?|pptx?|mp4|webm|mov|mp3|wav|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|eot)$/i;

export const DEFAULT_SITE_USER_AGENT = `${MIGRATION_CRAWLER_TOKEN}/1.0 (site migration)`;

interface RobotsState {
  readonly robots: Robots;
  readonly warning?: string;
  /** Why robots.txt couldn't be read; nothing is fetched while it is set. */
  readonly unavailable?: string;
}

export function createSiteSource(fetcher: RemoteFetcher, opts: SiteSourceOptions = {}): SiteSource {
  const userAgent = opts.userAgent ?? DEFAULT_SITE_USER_AGENT;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const robotsByOrigin = new Map<string, Promise<RobotsState>>();
  /** Per origin: the delay robots.txt asks (ms), the last request's start, and the queue. */
  const pace = new Map<string, { delayMs: number; last?: number; queue: Promise<unknown> }>();

  /**
   * Runs one request to `origin`. Unpaced, it just records its start; paced, it joins the
   * origin's queue and starts no sooner than the delay after the request before it.
   */
  const paced = <T>(origin: string, request: () => Promise<T>): Promise<T> => {
    const p = pace.get(origin) ?? { delayMs: 0, queue: Promise.resolve() };
    pace.set(origin, p);
    if (p.delayMs <= 0) {
      p.last = now();
      return request();
    }
    const run = async () => {
      if (p.last !== undefined) {
        const gap = p.last + p.delayMs - now();
        if (gap > 0) await wait(gap);
      }
      p.last = now();
      return request();
    };
    const result = p.queue.then(run);
    p.queue = result.catch(() => undefined);
    return result;
  };

  const robotsFor = (origin: string) => {
    let found = robotsByOrigin.get(origin);
    if (!found) {
      found = readRobots(origin);
      robotsByOrigin.set(origin, found);
    }
    return found;
  };
  const readRobots = async (origin: string): Promise<RobotsState> => {
    const url = `${origin}/robots.txt`;
    let state: RobotsState;
    try {
      const res = await paced(origin, () =>
        fetcher.get(url, { maxBytes: ROBOTS_MAX_BYTES, timeoutMs, userAgent }),
      );
      if (res.status >= 200 && res.status < 300) state = { robots: parseRobotsTxt(res.body) };
      else if (res.status >= 300 && res.status < 400) {
        state = {
          robots: ALLOW_ALL_ROBOTS,
          warning: `${url} answered ${res.status} (a redirect, not followed); read as no rules`,
        };
      } else if (res.status >= 400 && res.status < 500) state = { robots: ALLOW_ALL_ROBOTS };
      else state = unavailable(`${url} answered ${res.status}`);
    } catch (err) {
      state = unavailable(`${url} could not be read (${messageOf(err)})`);
    }
    // Not kept when unavailable: the next call asks again.
    if (state.unavailable) robotsByOrigin.delete(origin);
    const delayMs = robotsCrawlDelay(state.robots) * 1000;
    const p = pace.get(origin);
    if (p) p.delayMs = delayMs;
    return state;
  };

  const fetchPage = async (source: MigrationSource, url: string): Promise<FetchedPage> => {
    const origin = originOf(url);
    try {
      const res = await paced(origin, () =>
        fetcher.get(url, { maxBytes: SITE_PAGE_MAX_BYTES, timeoutMs, userAgent }),
      );
      const ct = res.contentType ? { contentType: res.contentType } : {};
      if (res.status < 200 || res.status >= 300) {
        // A redirect is a status here, never a hop: the fetcher won't follow one off the origin.
        return { url, status: res.status, ...ct, html: '', error: `answered ${res.status}` };
      }
      if (!isHtml(res.contentType, res.body)) {
        return { url, status: res.status, ...ct, html: '', error: `not HTML (${res.contentType})` };
      }
      const page: FetchedPage = { url, status: res.status, ...ct, html: res.body };
      if (source.kind !== 'crawl') return page;
      const { robots } = await robotsFor(origin);
      return { ...page, links: linksOf(res.body, url, origin, robots) };
    } catch (err) {
      return { url, status: 0, html: '', error: messageOf(err) };
    }
  };

  return {
    async fetchPages(source, urls): Promise<SiteFetch> {
      const origin = originOf(source.url);
      const state = await robotsFor(origin);
      if (state.unavailable) return { pages: [], unavailable: state.unavailable };
      const out: FetchedPage[] = [];
      for (let at = 0; at < urls.length; at += concurrency) {
        const batch = urls.slice(at, at + concurrency).map(async (raw): Promise<FetchedPage> => {
          const url = normalizePageUrl(raw);
          if (!url || originOf(url) !== origin) {
            return { url: raw, status: 0, html: '', error: 'not on the source origin' };
          }
          if (!robotsAllows(state.robots, new URL(url).pathname)) {
            return { url, status: 0, html: '', error: 'disallowed by robots.txt' };
          }
          return fetchPage(source, url);
        });
        out.push(...(await Promise.all(batch)));
      }
      return { pages: out };
    },

    async discover(source, onPage) {
      const origin = originOf(source.url);
      const state = await robotsFor(origin);
      const tally = new Tally(source, origin, state.robots);
      if (state.warning) tally.warnings.push(state.warning);
      if (state.unavailable) {
        // Nothing more is asked of the site, sitemaps included.
        tally.warnings.push(`${state.unavailable}; nothing is fetched while it can't be read`);
        return { ...tally.report(), unavailable: state.unavailable };
      }
      if (source.kind === 'sitemap')
        await discoverSitemaps(source, origin, state.robots, tally, onPage);
      else {
        // A crawl starts from its start page; its links come back with each fetch.
        const url = tally.considerStart(source.url);
        if (url) await onPage({ url });
      }
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
      if (!robotsAllows(robots, new URL(url).pathname)) {
        tally.warnings.push(`robots.txt disallows the sitemap ${url}; not read`);
        continue;
      }
      const xml = await readSitemap(origin, url, tally);
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

  async function readSitemap(
    origin: string,
    url: string,
    tally: Tally,
  ): Promise<string | undefined> {
    try {
      const file = await paced(origin, () =>
        fetcher.getBytes(url, { maxBytes: SITEMAP_MAX_BYTES, timeoutMs, userAgent }),
      );
      if (file.status < 200 || file.status >= 300) {
        tally.warnings.push(`sitemap ${url} answered ${file.status}`);
        return undefined;
      }
      const gzipped = file.bytes[0] === 0x1f && file.bytes[1] === 0x8b;
      return gzipped
        ? await gunzipText(file.bytes, SITEMAP_MAX_BYTES)
        : new TextDecoder().decode(file.bytes);
    } catch (err) {
      tally.warnings.push(`sitemap ${url} could not be read (${messageOf(err)})`);
      return undefined;
    }
  }
}

/**
 * A page's links a crawl may follow: same origin, robots-allowed, not files, not the page itself;
 * deduped, in order.
 */
function linksOf(html: string, pageUrl: string, origin: string, robots: Robots): string[] {
  const out = new Set<string>();
  for (const href of pageHrefs(html)) {
    const url = normalizePageUrl(href, pageUrl);
    if (!url || url === pageUrl || out.has(url) || originOf(url) !== origin) continue;
    const path = new URL(url).pathname;
    if (NON_PAGE.test(path) || !robotsAllows(robots, path)) continue;
    out.add(url);
  }
  return [...out];
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
    // The limit before robots: a full run asks nothing more of each entry.
    else if (this.full()) this.skipped.overLimit += 1;
    else if (!robotsAllows(this.robots, path)) this.skipped.robots += 1;
    else {
      this.taken += 1;
      return url;
    }
    return undefined;
  }

  /** A crawl's start page: taken whatever the globs say (they choose the pages it leads to). */
  considerStart(raw: string): string | undefined {
    const url = normalizePageUrl(raw) as string;
    this.discovered += 1;
    if (!robotsAllows(this.robots, new URL(url).pathname)) {
      this.skipped.robots += 1;
      this.warnings.push(`robots.txt disallows the start page ${url}`);
      return undefined;
    }
    this.taken += 1;
    return url;
  }

  report(): SiteDiscovery {
    return {
      discovered: this.discovered,
      skipped: { ...this.skipped },
      warnings: [...new Set(this.warnings)].slice(0, 50),
    };
  }
}

const unavailable = (why: string): RobotsState => ({
  robots: parseRobotsTxt('User-agent: *\nDisallow: /'),
  unavailable: why,
});

const originOf = (url: string): string => parseHttpUrl(url)?.origin ?? '';

function isHtml(contentType: string | undefined, body: string): boolean {
  if (contentType) return /text\/html|application\/xhtml\+xml/i.test(contentType);
  return /^\s*(<!doctype html|<html)/i.test(body.slice(0, 1024));
}

/** Gunzips to text as it streams, bounded: the decompressed bytes are never held whole. */
async function gunzipText(bytes: Uint8Array, maxBytes: number): Promise<string> {
  // The DOM lib types BodyInit as ArrayBuffer-backed views; this view is one, so cast rather than copy.
  const reader = new Response(bytes as Uint8Array<ArrayBuffer>).body
    ?.pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`uncompressed sitemap exceeds ${maxBytes} bytes`);
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
