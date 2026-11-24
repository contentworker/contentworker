import {
  decodeUtf8Range,
  encodeUtf8,
  type MigrationSource,
  normalizePageUrl,
  pageHrefs,
  parseHttpUrl,
  sourceTakesPath,
} from '@contentworker/domain';
import type {
  DiscoveredPage,
  FetchedPage,
  RemoteDocument,
  RemoteFetcher,
  RemoteFetchOptions,
  RemoteFile,
  SiteDiscovery,
  SiteFetch,
  SiteSource,
} from '@contentworker/ports';

/** One canned answer: a body (text or bytes), with its status (200) and content type. */
export interface FakeResponse {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string | Uint8Array;
}

/**
 * A remote fetcher over canned answers by exact URL; anything else answers 404. Records every
 * request with its options, so a test can check what was asked, how often and as whom. An
 * answer that is a function throws (a timeout, a reset).
 */
export class FakeRemoteFetcher implements RemoteFetcher {
  readonly requests: { url: string; options: RemoteFetchOptions }[] = [];
  constructor(private readonly answers: Record<string, FakeResponse | (() => never)> = {}) {}

  set(url: string, answer: FakeResponse | (() => never)): void {
    this.answers[url] = answer;
  }

  async getBytes(url: string, options: RemoteFetchOptions): Promise<RemoteFile> {
    this.requests.push({ url, options });
    const answer = this.answers[url] ?? { status: 404 };
    if (typeof answer === 'function') answer();
    const a = answer as FakeResponse;
    const status = a.status ?? 200;
    const ok = status >= 200 && status < 300;
    const body = a.body ?? '';
    const bytes = typeof body === 'string' ? encodeUtf8(body) : body;
    if (ok && bytes.byteLength > options.maxBytes) {
      throw new Error(`Response exceeds the ${options.maxBytes} byte limit`);
    }
    return {
      status,
      ...(a.contentType ? { contentType: a.contentType } : {}),
      bytes: ok ? bytes : new Uint8Array(),
    };
  }

  async get(url: string, options: RemoteFetchOptions): Promise<RemoteDocument> {
    const { bytes, ...rest } = await this.getBytes(url, options);
    return { ...rest, body: decodeUtf8Range(bytes, 0).text };
  }
}

/**
 * A site source over a fixed set of pages, for use-case tests. A sitemap source lists every page
 * the source's globs take (in the order given, up to `maxPages`); a crawl source hands over its
 * start page, and each fetched page carries its same-origin links, as the real source does.
 * A page given as a number answers that status. `unavailable` makes robots.txt unreadable.
 */
export class FakeSiteSource implements SiteSource {
  readonly fetched: string[] = [];
  readonly discoveries: MigrationSource[] = [];
  unavailable: string | undefined;
  constructor(
    private readonly pages: Record<string, string | number>,
    private readonly warnings: string[] = [],
  ) {}

  async discover(
    source: MigrationSource,
    onPage: (page: DiscoveredPage) => Promise<void>,
  ): Promise<SiteDiscovery> {
    this.discoveries.push(source);
    const skipped = { robots: 0, filtered: 0, offOrigin: 0, overLimit: 0, invalid: 0 };
    if (this.unavailable) {
      return {
        discovered: 0,
        skipped,
        warnings: [this.unavailable],
        unavailable: this.unavailable,
      };
    }
    if (source.kind === 'crawl') {
      await onPage({ url: normalizePageUrl(source.url) as string });
      return { discovered: 1, skipped, warnings: this.warnings };
    }
    let taken = 0;
    const urls = Object.keys(this.pages);
    for (const raw of urls) {
      const url = normalizePageUrl(raw) as string;
      if (!sourceTakesPath(source, parseHttpUrl(url)?.pathname ?? '/')) skipped.filtered += 1;
      else if (taken >= source.maxPages) skipped.overLimit += 1;
      else {
        taken += 1;
        await onPage({ url });
      }
    }
    return { discovered: urls.length, skipped, warnings: this.warnings };
  }

  async fetchPages(source: MigrationSource, urls: readonly string[]): Promise<SiteFetch> {
    if (this.unavailable) return { pages: [], unavailable: this.unavailable };
    this.fetched.push(...urls);
    return { pages: urls.map((url) => this.answer(source, url)) };
  }

  private answer(source: MigrationSource, url: string): FetchedPage {
    const page = this.pages[url];
    if (typeof page !== 'string') {
      const status = page ?? 404;
      return { url, status, html: '', error: `answered ${status}` };
    }
    const fetched: FetchedPage = { url, status: 200, contentType: 'text/html', html: page };
    if (source.kind !== 'crawl') return fetched;
    const origin = parseHttpUrl(url)?.origin;
    const links = [
      ...new Set(
        pageHrefs(page)
          .map((href) => normalizePageUrl(href, url))
          .filter((u): u is string => Boolean(u) && parseHttpUrl(u as string)?.origin === origin),
      ),
    ];
    return { ...fetched, links };
  }
}
