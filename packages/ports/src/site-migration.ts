import type {
  MigrationPage,
  MigrationPageStage,
  MigrationRun,
  MigrationSource,
  MigrationTemplate,
  Scope,
} from '@contentworker/domain';

/**
 * A site migration's records: runs, their templates and their pages, environment-scoped. Page
 * HTML and script outputs are not here; they are objects in the blob store, and these records
 * hold their keys and hashes (`MigrationArtifact`).
 *
 * The run's `version` guards its templates: every template write rides in one unit of work with
 * the run's {@link MigrationStore.saveRun} compare-and-set, so two writers can't interleave a
 * run's templates. Page writes don't need it: each is a whole page, and a page's step is safe to
 * repeat.
 */
export interface MigrationStore {
  createRun(scope: Scope, run: MigrationRun): Promise<void>;
  getRun(scope: Scope, id: string): Promise<MigrationRun | null>;
  /** Newest first. */
  listRuns(scope: Scope, opts: { readonly limit: number }): Promise<MigrationRun[]>;
  /**
   * Rewrites the run at a compare-and-set on `version`: it is written only while the stored
   * version is `expected`. A lost race throws `TransactionConflictError` (inside a unit of work,
   * at commit).
   */
  saveRun(scope: Scope, run: MigrationRun, expected: number): Promise<void>;

  /**
   * Adds pages a run discovered. A page whose URL the run already holds is left as it is, so
   * discovering a page again (a re-run inventory, a redelivered step) changes nothing. Any number
   * of pages; callers keep a call to a few hundred, which is one batch.
   */
  addPages(scope: Scope, runId: string, pages: readonly MigrationPage[]): Promise<void>;
  /** Rewrites pages the run holds, whole (a fetch's result, a stage move). Unknown ids are skipped. */
  savePages(scope: Scope, runId: string, pages: readonly MigrationPage[]): Promise<void>;
  getPage(scope: Scope, runId: string, id: string): Promise<MigrationPage | null>;
  /** Which of `urls` the run already holds (any number of URLs). */
  knownUrls(scope: Scope, runId: string, urls: readonly string[]): Promise<string[]>;
  /** Pages in id order (discovery order), after the `after` id. */
  listPages(scope: Scope, runId: string, query: MigrationPageQuery): Promise<MigrationPage[]>;
  countPages(scope: Scope, runId: string): Promise<MigrationPageCounts>;

  /** The run's templates, largest first. */
  listTemplates(scope: Scope, runId: string): Promise<MigrationTemplate[]>;
  getTemplate(scope: Scope, runId: string, id: string): Promise<MigrationTemplate | null>;
  /**
   * Replaces the run's templates with `clusters`, atomically: the old templates go, each new one
   * is written, its pages point at it and move to `clustered`, and every other page of the run
   * goes back to `discovered` with no template; every page's `updatedAt` becomes `at`.
   * Refused (`TransactionConflictError`, inside a unit of work at commit) while any of the run's
   * templates is past `pending`: authored or approved work is never replaced. Ride it with the
   * run's `saveRun`.
   */
  replaceTemplates(
    scope: Scope,
    runId: string,
    clusters: readonly MigrationCluster[],
    at: string,
  ): Promise<void>;
}

export interface MigrationCluster {
  readonly template: MigrationTemplate;
  readonly pageIds: readonly string[];
}

export interface MigrationPageQuery {
  readonly limit: number;
  readonly after?: string;
  readonly stage?: MigrationPageStage;
  readonly templateId?: string;
  /**
   * `pending`: not fetched yet and not failed (the fetch step's work). `fetched`: with HTML (what
   * clustering reads). Absent, either.
   */
  readonly fetch?: 'pending' | 'fetched';
}

export interface MigrationPageCounts {
  readonly total: number;
  /** Pages with HTML. */
  readonly fetched: number;
  /** Pages whose last step failed (`error` set). */
  readonly failed: number;
  readonly byStage: Readonly<Partial<Record<MigrationPageStage, number>>>;
}

/**
 * Reads a published website for a migration: discovers its pages through a sitemap or a link
 * crawl, and fetches them. Every request stays on the source URL's origin (which the caller has
 * screened), keeps to the site's robots.txt, and is spaced as it asks.
 */
export interface SiteSource {
  /**
   * Walks a sitemap source and hands each page it takes to `onPage`, in order, awaiting each (so a
   * caller can write as it goes), up to the source's `maxPages`. A crawl source hands over its
   * start page only: the crawl itself goes a batch at a time through {@link fetchPages}, whose
   * pages carry their links, so the run's pages are the crawl's frontier and a crawl resumes
   * where it stopped.
   */
  discover(
    source: MigrationSource,
    onPage: (page: DiscoveredPage) => Promise<void>,
  ): Promise<SiteDiscovery>;
  /**
   * Fetches pages (a bounded batch), a few at a time or as far apart as the site asks. Never
   * throws for one page's failure. When the site's robots.txt can't be read (a server error, no
   * answer), nothing is fetched and `unavailable` says why: try the batch again later.
   */
  fetchPages(source: MigrationSource, urls: readonly string[]): Promise<SiteFetch>;
}

export interface SiteFetch {
  readonly pages: FetchedPage[];
  readonly unavailable?: string;
}

export interface DiscoveredPage {
  /** Normalized: absolute, no fragment or query. */
  readonly url: string;
  readonly lastModified?: string;
  /** The page as the crawl fetched it. */
  readonly fetched?: FetchedPage;
}

export interface FetchedPage {
  readonly url: string;
  /** HTTP status; 0 when no response came (refused, timed out, too large). */
  readonly status: number;
  readonly contentType?: string;
  /** The HTML; empty unless the page answered 2xx with HTML. */
  readonly html: string;
  /** Why there is no HTML, when there isn't. */
  readonly error?: string;
  /**
   * A crawl's next pages: the page's links, normalized, on the source origin, allowed by
   * robots.txt and not to files (images, PDFs, feeds). The source's globs are the caller's.
   */
  readonly links?: readonly string[];
}

export interface SiteDiscovery {
  /** Pages the source listed or the crawl reached, before filtering. */
  readonly discovered: number;
  readonly skipped: {
    readonly robots: number;
    readonly filtered: number;
    readonly offOrigin: number;
    readonly overLimit: number;
    readonly invalid: number;
  };
  readonly warnings: readonly string[];
  /** Set when robots.txt couldn't be read, so nothing was: try again later. */
  readonly unavailable?: string;
}
