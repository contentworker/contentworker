import type { ContentTypeDraft } from '../content-type/content-type';
import { ConflictError, type FieldIssue, InvalidStateError, ValidationError } from '../errors';
import { compileWildcard, matchWildcard, type Wildcard } from './wildcard';

/**
 * Site migration: bringing a published website into an environment as structured content.
 *
 * A run starts from a source (a sitemap, or a crawl from one page), inventories the site's pages,
 * clusters them by structure into templates, and moves each page through its stages: an import
 * script per template turns the page into typed fields and blocks, the output is scored against
 * the source, and pages that pass are loaded as entries and published. Page HTML and script
 * outputs are artifacts in object storage; a run, its templates and its pages are records that
 * name them by key and hash.
 */

/** Where a run finds its pages: a sitemap (or sitemap index), or a same-origin link crawl. */
export type MigrationSourceKind = 'sitemap' | 'crawl';

export interface MigrationSource {
  readonly kind: MigrationSourceKind;
  /**
   * `sitemap`: the sitemap or sitemap index URL, or the site's origin (its robots.txt `Sitemap`
   * lines are read, then `/sitemap.xml`). `crawl`: the page the crawl starts from. Every page the
   * run takes shares this URL's origin.
   */
  readonly url: string;
  /** Path globs a page must match one of; empty, every page. `*` stays in a segment, `**` crosses. */
  readonly include: readonly string[];
  /** Path globs that leave a page out, over `include`. */
  readonly exclude: readonly string[];
  /** Most pages the run takes. */
  readonly maxPages: number;
}

export const MIGRATION_SOURCE_KINDS: readonly MigrationSourceKind[] = ['sitemap', 'crawl'];
/** Pages a run takes when the source names no limit. */
export const MIGRATION_DEFAULT_MAX_PAGES = 500;
/** Most pages one run takes. */
export const MIGRATION_MAX_PAGES = 10_000;
/** Links deep a crawl follows from its start page. */
export const MIGRATION_MAX_CRAWL_DEPTH = 8;
/** Most include or exclude globs, each. */
export const MIGRATION_MAX_GLOBS = 50;
export const MIGRATION_MAX_GLOB_LENGTH = 512;
export const MIGRATION_MAX_URL_LENGTH = 2048;
export const MIGRATION_MAX_NAME_LENGTH = 200;
/**
 * The field a migrated page's entry holds its source URL in: the identity a load matches on, so
 * loading a page again updates its entry rather than adding a second. Every template's content
 * type has it (`Symbol` or `Text`, not localized).
 */
export const MIGRATION_SOURCE_URL_FIELD = 'sourceUrl';
/** Score at or above which a page's output counts as validated, unless the run sets its own. */
export const MIGRATION_DEFAULT_THRESHOLD = 0.8;

/**
 * A run's progress as a whole. Pages carry their own stage; the run says which step last
 * finished, so a caller (or the Workflow driving it) knows what comes next.
 *
 * `stopped`: its background driver ended without publishing, because no template was approved in
 * time or the go-ahead to publish never came. The run can't be started again, but its templates
 * can still be authored, approved, loaded and published step by step. `failed` is final.
 */
export type MigrationRunStatus = 'created' | 'inventoried' | 'clustered' | 'stopped' | 'failed';

/** Statuses a run's driver can't be started or told anything in. */
export const MIGRATION_RUN_ENDED: ReadonlySet<MigrationRunStatus> = new Set(['stopped', 'failed']);

/**
 * The run's driver instance exists but has finished (completed, failed or was terminated), so it
 * waits for nothing: an approval or a go-ahead sent to it would be lost.
 */
export class MigrationDriverFinishedError extends InvalidStateError {
  constructor(runId: string) {
    super(
      `The migration run "${runId}" has a driver that has finished: take the run on step by step`,
    );
  }
}

/**
 * The template's approval a step began under no longer holds: it was reopened, or reopened and
 * approved again, meanwhile. Nothing of the step was recorded; it starts over from the template
 * as it is now.
 */
export class MigrationApprovalChangedError extends ConflictError {
  constructor() {
    super(
      'The template was reopened while its pages were being taken on: go on once it is approved again',
    );
  }
}

/**
 * The run's background driver has taken its templates on (`clusteringHeldAt`): it waits for their
 * approvals by id, so grouping the pages again would leave it waiting for templates that are gone.
 */
export class MigrationClusteringHeldError extends InvalidStateError {
  constructor() {
    super(
      'The run’s templates were taken on in the background, so its pages can’t be clustered again: go on with these templates, or create another run to group the pages another way',
    );
  }
}

/**
 * The run's go-ahead to publish is taken: it was given once, by someone else or for another target,
 * and stands. Says neither who nor what: a caller who may publish may not be one who reads runs.
 */
export class MigrationGoAheadTakenError extends ConflictError {
  constructor() {
    super(
      'The go-ahead to publish this run was already given, and it stands: another can’t replace it',
      { reason: 'go_ahead_taken' },
    );
  }
}

/** What an inventory found, and what it left out and why. */
export interface MigrationInventory {
  /** Pages the source listed or the crawl reached, before filtering. */
  readonly discovered: number;
  /** Pages added to the run. */
  readonly added: number;
  readonly skipped: {
    /** Disallowed by the site's robots.txt. */
    readonly robots: number;
    /** Left out by the run's include and exclude globs. */
    readonly filtered: number;
    /** On another origin than the source URL. */
    readonly offOrigin: number;
    /** Over the run's `maxPages`. */
    readonly overLimit: number;
    /** Not a usable http(s) URL. */
    readonly invalid: number;
  };
  /** Things an operator should know: an unreadable sitemap, a redirected start page. */
  readonly warnings: readonly string[];
}

export interface MigrationRun {
  readonly id: string;
  readonly name: string;
  readonly source: MigrationSource;
  readonly status: MigrationRunStatus;
  /** Score a page's output needs to count as validated (0..1). */
  readonly threshold: number;
  readonly inventory: MigrationInventory | null;
  /** Why the run failed or stopped, when it did. */
  readonly error: string | null;
  /**
   * The release its entries were added to when publishing goes through one: an add run again
   * reuses it while it is open, rather than opening another.
   */
  readonly releaseId: string | null;
  /**
   * When the run's driver took its templates on, from when its pages aren't clustered again. Null
   * until one does. It is never cleared: what ends a driver may not be recorded on the run, and the
   * templates can be taken on step by step, or by another driver, as they are.
   */
  readonly clusteringHeldAt: string | null;
  /**
   * Who started its background driver, and when. Null while it was never started, and for a run
   * started before this was recorded, whose driver (if it has one) and go-ahead aren't known here.
   */
  readonly driver: MigrationDriverRecord | null;
  /** The go-ahead to publish given to its driver: written once, at the compare-and-set. */
  readonly goAhead: MigrationGoAhead | null;
  /** Counts up from 1 with every write; the compare-and-set each write rides with. */
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly updatedAt: string;
}

/**
 * A page's way through a run: found, put in a template, turned into structured output by the
 * template's script, scored (`validated` at the run's threshold, `needs-fix` below it), loaded as
 * an entry, and published.
 */
export const MIGRATION_PAGE_STAGES = [
  'discovered',
  'clustered',
  'transformed',
  'validated',
  'needs-fix',
  'loaded',
  'published',
] as const;
export type MigrationPageStage = (typeof MIGRATION_PAGE_STAGES)[number];

/** A file a record names: its object key, SHA-256 (hex) and size in bytes. */
export interface MigrationArtifact {
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface MigrationPage {
  readonly id: string;
  readonly runId: string;
  /** Absolute URL, without fragment or query: one page per URL in a run. */
  readonly url: string;
  /** The URL's path, which redirects and slugs are made from. */
  readonly path: string;
  /** Links from a crawl's start page (0); 0 for a sitemap's pages. */
  readonly depth: number;
  readonly stage: MigrationPageStage;
  readonly templateId: string | null;
  readonly title: string | null;
  /** As the sitemap gave it (`lastmod`), when it did. */
  readonly lastModified: string | null;
  /** Status of the last fetch; null before one. */
  readonly httpStatus: number | null;
  /** The page as fetched; null until it is. */
  readonly html: MigrationArtifact | null;
  /** Structure fingerprint of the fetched HTML ({@link structureFingerprint}). */
  readonly fingerprint: readonly string[] | null;
  /** The import script's structured output for it; null until transformed. */
  readonly output: MigrationArtifact | null;
  /**
   * The version of its template its last transform ran (whether it produced `output` or failed):
   * the review digest of the model and script as approved. Null until transformed. A page
   * transformed before templates could be reopened holds the script's SHA-256 alone. A page of an
   * earlier version than the approved one is transformed again, unless it is loaded.
   */
  readonly outputScript: string | null;
  readonly score: MigrationScore | null;
  /** The entry it was loaded as. */
  readonly entryId: string | null;
  /**
   * Links in its entry to pages of the run that had no entry when it was loaded, left as
   * hyperlinks for the relink pass to point at their entries; 0 when there are none.
   */
  readonly unresolvedLinks: number;
  /** Why its last step failed (a fetch that answered 404, a script that threw). */
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An approved template goes back to `authoring` when it is reopened, keeping its `contentTypeId`.
 * `approving`: an approval holds the template while it writes the content type; authoring writes
 * are refused until it finishes or lets go.
 */
export type MigrationTemplateStatus = 'pending' | 'authoring' | 'approving' | 'approved';

/** Pages that share a structure, and so one content type and one import script. */
export interface MigrationTemplate {
  readonly id: string;
  readonly runId: string;
  readonly label: string;
  readonly status: MigrationTemplateStatus;
  readonly pageCount: number;
  /** Representative pages, spread over the template, for authoring and trying its script. */
  readonly samplePageIds: readonly string[];
  /** The structure its pages share: the first page's fingerprint, which others were matched to. */
  readonly fingerprint: readonly string[];
  /**
   * The content type its pages become, once approved. Kept when the template is reopened: pages
   * loaded already are entries of that type, so a new approval revises it rather than another.
   */
  readonly contentTypeId: string | null;
  /** Its import script, once written. */
  readonly script: MigrationArtifact | null;
  /**
   * The content type its pages are proposed to become ({@link checkTemplateModel}): recorded
   * while the template is authored, and created only when it is approved.
   */
  readonly proposal: ContentTypeDraft | null;
  /** How its script did the last time it was tried on the sample pages. */
  readonly lastTry: MigrationTrySummary | null;
  /** Who approved it: its pages are loaded as them. Null until approved, and while reopened. */
  readonly approvedBy: MigrationActor | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Who a migration's background steps act as, by reference, resolved again before each step that
 * writes content: an API key, a team member, or the deployment's own authority. Never a credential.
 */
export type MigrationActor =
  | { readonly kind: 'key'; readonly keyId: string }
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'deployment' };

export const isMigrationActor = (v: unknown): v is MigrationActor => {
  const a = v as Partial<Record<string, unknown>> | null | undefined;
  return (
    (a?.kind === 'key' && typeof a.keyId === 'string') ||
    (a?.kind === 'member' && typeof a.memberId === 'string') ||
    a?.kind === 'deployment'
  );
};

export const sameMigrationActor = (a: MigrationActor | null, b: MigrationActor): boolean =>
  a?.kind === b.kind &&
  (a.kind !== 'key' || (b.kind === 'key' && a.keyId === b.keyId)) &&
  (a.kind !== 'member' || (b.kind === 'member' && a.memberId === b.memberId));

/** The start of a run's background driver, as its run records it. */
export interface MigrationDriverRecord {
  readonly startedBy: MigrationActor;
  readonly startedAt: string;
}

/**
 * Where a run's background driver is: `none` (it has none), `running`, `waiting` (for an approval,
 * the go-ahead, a site it can't read or a retry), `paused` (by an operator), `finished`, or
 * `unknown` (it couldn't be asked now).
 */
export const MIGRATION_DRIVER_STATUSES = [
  'none',
  'running',
  'waiting',
  'paused',
  'finished',
  'unknown',
] as const;
export type MigrationDriverStatus = (typeof MIGRATION_DRIVER_STATUSES)[number];

/** How a run's entries go out: published now, or (`viaRelease`) added to a release. */
export interface MigrationPublishTarget {
  readonly viaRelease?: boolean;
  /** The open release to add to; absent, the run's own. */
  readonly releaseId?: string;
  readonly releaseTitle?: string;
}

/** A target with only what it says: no blank or false parts, the title trimmed. */
export function migrationPublishTarget(input: {
  readonly viaRelease?: boolean | undefined;
  readonly releaseId?: string | undefined;
  readonly releaseTitle?: string | undefined;
}): MigrationPublishTarget {
  const title = input.releaseTitle?.trim();
  return {
    ...(input.viaRelease ? { viaRelease: true } : {}),
    ...(input.releaseId ? { releaseId: input.releaseId } : {}),
    ...(title ? { releaseTitle: title } : {}),
  };
}

export const sameMigrationTarget = (
  a: MigrationPublishTarget,
  b: MigrationPublishTarget,
): boolean =>
  !!a.viaRelease === !!b.viaRelease &&
  a.releaseId === b.releaseId &&
  a.releaseTitle === b.releaseTitle;

/** The go-ahead to publish a run: who gave it, when, and for what. Never replaced by another. */
export interface MigrationGoAhead {
  readonly approvedBy: MigrationActor;
  readonly at: string;
  readonly target: MigrationPublishTarget;
  /**
   * When it certainly reached the driver (its event was taken in, or the driver acted on it); null
   * while that isn't known, when whoever gave it can send it again.
   */
  readonly deliveredAt: string | null;
}

/** A try of a template's script on its sample pages, as the template keeps it. */
export interface MigrationTrySummary {
  readonly at: string;
  /** SHA-256 of the script that was tried. */
  readonly scriptSha256: string;
  /** Sample pages tried. */
  readonly pages: number;
  /** Pages whose run returned an output of the right shape. */
  readonly ok: number;
  /** Pages scored at or above the run's threshold. */
  readonly passed: number;
  /** Mean overall score over the pages that ran (0 when none did). */
  readonly meanScore: number;
  /** The first few failures and issues, one line each. */
  readonly problems: readonly string[];
}

/** How well a page's structured output kept its source ({@link scoreImportOutput}). */
export interface MigrationScore {
  /** 0..1, compared against the run's threshold. */
  readonly overall: number;
  /** Share of the source's content words present in the output (0..1). */
  readonly textCoverage: number;
  /** Output assets with no URL. */
  readonly imagesMissing: number;
  /** Content images in the source with no asset in the output. */
  readonly imagesLost: number;
  /** Content links in the source, and links in the output. */
  readonly sourceLinks: number;
  readonly outputLinks: number;
  readonly issues: readonly string[];
}

/** Input to a new run's source; what is left out takes its default. */
export interface MigrationSourceInput {
  readonly kind: MigrationSourceKind;
  readonly url: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly maxPages?: number;
}

/**
 * Checks a run's source and fills in its defaults. Shape only: whether the URL may be fetched
 * (not a private or loopback address) is the outbound guard's to say.
 */
export function checkMigrationSource(input: MigrationSourceInput): MigrationSource {
  const issues: FieldIssue[] = [];
  if (!MIGRATION_SOURCE_KINDS.includes(input.kind)) {
    issues.push({ field: 'source.kind', message: 'must be "sitemap" or "crawl"' });
  }
  const url = typeof input.url === 'string' ? parseHttpUrl(input.url) : undefined;
  if (!url || input.url.length > MIGRATION_MAX_URL_LENGTH) {
    issues.push({
      field: 'source.url',
      message: `must be an absolute http or https URL of at most ${MIGRATION_MAX_URL_LENGTH} characters`,
    });
  } else if (url.username || url.password) {
    // Credentials in a URL would be sent to the site and stored on the run in the clear.
    issues.push({ field: 'source.url', message: 'must not carry a user name or password' });
  }
  const maxPages = input.maxPages ?? MIGRATION_DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MIGRATION_MAX_PAGES) {
    issues.push({
      field: 'source.maxPages',
      message: `must be a whole number from 1 to ${MIGRATION_MAX_PAGES}`,
    });
  }
  const globs = (field: 'include' | 'exclude'): string[] => {
    const list = input[field] ?? [];
    if (!Array.isArray(list) || list.length > MIGRATION_MAX_GLOBS) {
      issues.push({
        field: `source.${field}`,
        message: `must be a list of at most ${MIGRATION_MAX_GLOBS} path globs`,
      });
      return [];
    }
    list.forEach((glob, i) => {
      if (
        typeof glob !== 'string' ||
        !glob.startsWith('/') ||
        glob.length > MIGRATION_MAX_GLOB_LENGTH
      ) {
        issues.push({
          field: `source.${field}[${i}]`,
          message: `must be a path glob starting with "/", at most ${MIGRATION_MAX_GLOB_LENGTH} characters`,
        });
      }
    });
    return [...list];
  };
  const include = globs('include');
  const exclude = globs('exclude');
  if (issues.length > 0 || !url) throw new ValidationError(issues);
  return { kind: input.kind, url: url.href, include, exclude, maxPages };
}

/** Checks a run's name (trimmed; empty takes the source's host) and threshold. */
export function checkMigrationRunInput(input: {
  readonly name?: string;
  readonly threshold?: number;
  readonly source: MigrationSource;
}): { name: string; threshold: number } {
  const issues: FieldIssue[] = [];
  const name = (input.name ?? '').trim() || (parseHttpUrl(input.source.url)?.host ?? '');
  if (name.length > MIGRATION_MAX_NAME_LENGTH) {
    issues.push({
      field: 'name',
      message: `must be at most ${MIGRATION_MAX_NAME_LENGTH} characters`,
    });
  }
  const threshold = input.threshold ?? MIGRATION_DEFAULT_THRESHOLD;
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) {
    issues.push({ field: 'threshold', message: 'must be a number from 0 to 1' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { name, threshold };
}

/**
 * The parts of a WHATWG URL the migration reads. The domain has no DOM or runtime lib, so the
 * global is declared here (as `rich-text/embed.ts` does); every runtime the domain runs on has it.
 */
export interface PageUrl {
  readonly href: string;
  readonly protocol: string;
  readonly host: string;
  readonly origin: string;
  readonly pathname: string;
  readonly username: string;
  readonly password: string;
  search: string;
  hash: string;
}
declare const URL: new (input: string, base?: string | PageUrl) => PageUrl;

/** The URL, if it is an absolute http(s) one. */
export function parseHttpUrl(raw: string, base?: string | PageUrl): PageUrl | undefined {
  let url: PageUrl;
  try {
    url = new URL(raw, base);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
}

/**
 * The URL a page is known by in a run: absolute, with no fragment and no query. A query on a
 * published page is far more often tracking or state than a different page, and keeping it would
 * take the same page many times.
 */
export function normalizePageUrl(raw: string, base?: string | PageUrl): string | undefined {
  const url = parseHttpUrl(raw.trim(), base);
  if (!url || url.username || url.password) return undefined;
  url.hash = '';
  url.search = '';
  return url.href;
}

/** True when `path` matches the glob: `*` is any run within a segment, `**` any run at all. */
export function matchesPathGlob(path: string, glob: string): boolean {
  let compiled = GLOBS.get(glob);
  if (!compiled) {
    compiled = compileWildcard(glob, 'glob');
    if (GLOBS.size >= 1_000) GLOBS.clear();
    GLOBS.set(glob, compiled);
  }
  return matchWildcard(compiled, path);
}

/** Compiled globs by pattern: a run checks every page against the same few. */
const GLOBS = new Map<string, Wildcard>();

/** Whether the source's globs take a page at `path`: on an include (if any), on no exclude. */
export function sourceTakesPath(source: MigrationSource, path: string): boolean {
  if (source.exclude.some((g) => matchesPathGlob(path, g))) return false;
  return source.include.length === 0 || source.include.some((g) => matchesPathGlob(path, g));
}

/** The stage a scored page moves to. */
export function stageForScore(score: MigrationScore, threshold: number): MigrationPageStage {
  return score.overall >= threshold ? 'validated' : 'needs-fix';
}
