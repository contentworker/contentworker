import type {
  MigrationActor,
  MigrationDriverStatus,
  MigrationPage,
  MigrationPageStage,
  MigrationPublishTarget,
  MigrationRun,
  MigrationSource,
  MigrationTemplate,
  MigrationTrySummary,
  Scope,
} from '@contentworker/domain';
import type { MigrationTokenStore } from './site-migration-tokens';

/**
 * A site migration's records: runs, their templates and their pages, environment-scoped. Page
 * HTML and script outputs are not here; they are objects in the blob store, and these records
 * hold their keys and hashes (`MigrationArtifact`).
 *
 * The run's `version` guards its templates: every template write rides in one unit of work with
 * the run's {@link MigrationStore.saveRun} compare-and-set, so two writers can't interleave a
 * run's templates. Page writes don't need it: each is a whole page, and a page's step is safe to
 * repeat. A step whose effects reach past the page (a load writes entries) moves its pages with
 * {@link MigrationStore.movePages} instead, at a compare-and-set on each page's `updatedAt`.
 */
export interface MigrationStore extends MigrationTokenStore {
  /** The token cap is the run's for good: no later write names it. Absent, the default. */
  createRun(
    scope: Scope,
    run: MigrationRun,
    opts?: { readonly agentTokenCap?: number },
  ): Promise<void>;
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
  /**
   * Rewrites pages whole, each only while it is as it was read: its stored `updatedAt` is the
   * move's `expected`. A page written meanwhile (another step moved or rescored it) fails the
   * whole call with `TransactionConflictError` (inside a unit of work, at commit, so nothing of
   * the unit is written). Any number of pages.
   */
  movePages(scope: Scope, runId: string, moves: readonly MigrationPageMove[]): Promise<void>;
  /**
   * Marks a template's pages whose `outputScript` is `from` as `to`, written `at`, touching nothing
   * else of them (a step that read one before loses its compare-and-set, and reads it again): how
   * reopening a template keeps the version of outputs recorded by
   * their script alone.
   */
  stampOutputs(
    scope: Scope,
    runId: string,
    templateId: string,
    from: string,
    to: string,
    at: string,
  ): Promise<void>;
  /**
   * Fails the unit of work with `TransactionConflictError` unless the template is `approved` at
   * `version` as the unit commits: what keeps a page from moving under an approval since withdrawn.
   */
  expectApproved(scope: Scope, runId: string, templateId: string, version: number): Promise<void>;
  getPage(scope: Scope, runId: string, id: string): Promise<MigrationPage | null>;
  /** The entries the run's pages at `urls` were loaded as (any number of URLs; none, absent). */
  entriesByUrl(
    scope: Scope,
    runId: string,
    urls: readonly string[],
  ): Promise<{ url: string; entryId: string }[]>;
  /**
   * The assets the run created from `urls` (any number of URLs), so a file a run has brought in
   * is not downloaded again for another page or a second load.
   */
  assetsByUrl(
    scope: Scope,
    runId: string,
    urls: readonly string[],
  ): Promise<{ url: string; assetId: string }[]>;
  /** Records assets the run created from URLs; a URL it already holds keeps its asset. */
  addAssets(
    scope: Scope,
    runId: string,
    assets: readonly { url: string; assetId: string }[],
    at: string,
  ): Promise<void>;
  /** Which of `urls` the run already holds (any number of URLs). */
  knownUrls(scope: Scope, runId: string, urls: readonly string[]): Promise<string[]>;
  /** Pages in id order (discovery order), after the `after` id. */
  listPages(scope: Scope, runId: string, query: MigrationPageQuery): Promise<MigrationPage[]>;
  countPages(scope: Scope, runId: string): Promise<MigrationPageCounts>;
  /**
   * A template's fetched pages by stage, and how many of each have an output of one of `versions`
   * (`outputScript`).
   */
  countOutputs(
    scope: Scope,
    runId: string,
    templateId: string,
    versions: readonly string[],
  ): Promise<MigrationOutputCount[]>;

  /** The run's templates, largest first. */
  listTemplates(scope: Scope, runId: string): Promise<MigrationTemplate[]>;
  getTemplate(scope: Scope, runId: string, id: string): Promise<MigrationTemplate | null>;
  /**
   * Rewrites one of the run's templates whole (its proposal, script, status, last try); an id
   * the run doesn't hold is skipped. No compare-and-set of its own: ride it with the run's
   * `saveRun`, which is what keeps two writers of a run's templates apart.
   */
  saveTemplate(scope: Scope, runId: string, template: MigrationTemplate): Promise<void>;
  /**
   * Sets only a template's `lastTry`, outside the run's compare-and-set (a try's summary is
   * nobody's to race over, and isn't part of what is reviewed). An id the run doesn't hold is
   * skipped.
   */
  saveTemplateTry(
    scope: Scope,
    runId: string,
    templateId: string,
    lastTry: MigrationTrySummary,
  ): Promise<void>;
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

/** What a migration run's durable driver starts with. */
export interface MigrationRunParams {
  readonly scope: Scope;
  readonly runId: string;
  /** Who started it: the inventory, transforms and the template agents act for them. */
  readonly startedBy: MigrationActor;
  /**
   * Started by an api that records go-aheads on the run, so the driver records its start there too.
   * Absent from one started before that, whose go-ahead may be an event alone.
   */
  readonly recorded?: true;
}

/**
 * A template's approval, delivered to the run's driver: a wake-up only. Who approved it is read
 * from the template (`approvedBy`), which `approveTemplate` writes; the event's word is not taken.
 */
export interface MigrationTemplateApproved {
  readonly approvedBy?: MigrationActor;
}

/**
 * The go-ahead to publish a run, delivered to its driver. With `recorded` it is a wake-up only: the
 * run holds the go-ahead (`MigrationRun.goAhead`) and the driver takes it from there. Without, it
 * was sent before go-aheads were recorded, and is itself the go-ahead.
 */
export interface MigrationPublishApproved extends MigrationPublishTarget {
  readonly approvedBy: MigrationActor;
  readonly recorded?: true;
}

/**
 * What starting a run's driver found: `started` by this call, `running` already (waiting counts),
 * or `finished` (completed, errored or terminated, and still held by Workflows).
 */
export type MigrationDriverState = 'started' | 'running' | 'finished';

/**
 * Starts and signals a migration run's durable driver (one Workflow instance per run). Each call
 * is safe to repeat: starting a run that has a driver leaves it as it is, and an approval sent
 * twice is taken once (the driver waits for each event once). Signalling a run with no driver
 * throws `NotFoundError`, and one whose driver has finished `MigrationDriverFinishedError`.
 */
export interface MigrationRunner {
  start(params: MigrationRunParams): Promise<MigrationDriverState>;
  templateApproved(
    scope: Scope,
    runId: string,
    templateId: string,
    event: MigrationTemplateApproved,
  ): Promise<void>;
  publishApproved(scope: Scope, runId: string, event: MigrationPublishApproved): Promise<void>;
  /** The run's driver now. Throws when it can't be asked; never reads that as `none`. */
  status(scope: Scope, runId: string): Promise<MigrationDriverStatus>;
}

export interface MigrationCluster {
  readonly template: MigrationTemplate;
  readonly pageIds: readonly string[];
}

/** A page to write, and the `updatedAt` it must still have ({@link MigrationStore.movePages}). */
export interface MigrationPageMove {
  readonly page: MigrationPage;
  readonly expected: string;
}

export interface MigrationPageQuery {
  readonly limit: number;
  readonly after?: string;
  readonly stage?: MigrationPageStage;
  readonly templateId?: string;
  /** Only pages whose `outputScript` is one of these. */
  readonly outputScript?: readonly string[];
  /** Only pages whose entry holds links the relink pass may still resolve (`unresolvedLinks`). */
  readonly unresolvedLinks?: true;
  /** `false`: only pages whose last step didn't fail (`error` unset); `true`, only those that did. */
  readonly failed?: boolean;
  /**
   * `pending`: not fetched yet and not failed (the fetch step's work). `fetched`: with HTML (what
   * clustering reads). Absent, either.
   */
  readonly fetch?: 'pending' | 'fetched';
}

export interface MigrationOutputCount {
  readonly stage: MigrationPageStage;
  readonly pages: number;
  /** Of them, those whose output is of one of the versions asked for. */
  readonly current: number;
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
