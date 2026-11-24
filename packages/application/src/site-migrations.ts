import {
  checkMigrationRunInput,
  checkMigrationSource,
  clusterByStructure,
  DomainError,
  InvalidStateError,
  MIGRATION_MAX_CRAWL_DEPTH,
  MIGRATION_PAGE_STAGES,
  type MigrationArtifact,
  type MigrationInventory,
  type MigrationPage,
  type MigrationPageStage,
  type MigrationRun,
  type MigrationSourceInput,
  type MigrationTemplate,
  NotFoundError,
  readPageFacts,
  type Scope,
  sourceTakesPath,
  ValidationError,
} from '@contentworker/domain';
import type {
  BlobStore,
  DiscoveredPage,
  FetchedPage,
  MigrationCluster,
  MigrationPageCounts,
  SiteSource,
} from '@contentworker/ports';
import type { AppContext } from './context';
import { outputVersions } from './site-migration-version';
import { sha256Hex } from './token-crypto';
import { assertSafeExternalUrl } from './url-safety';

/**
 * Site migration, the first steps: create a run, inventory its source, fetch its pages, and
 * cluster them into templates. Each step is safe to run again (a redelivered Workflow step): an
 * inventory adds only URLs the run doesn't have, a fetch takes only pages not fetched yet, and a
 * clustering replaces the run's templates whole at the run's compare-and-set.
 *
 * Page HTML goes to the blob store, content-addressed under the run
 * (`migrations/<space>/<environment>/<run>/html/<sha256>.html`, and `script/<sha256>.js` and
 * `output/<sha256>.json` for import scripts and their outputs): a step repeated with the same
 * page writes the same object, and a record never names an object that holds other bytes.
 */

/** What a source page fetch reads at most per call: one Workflow step's worth. */
export const MIGRATION_FETCH_BATCH_MAX = 50;
const MIGRATION_FETCH_BATCH_DEFAULT = 25;
/** Pages written per store call while an inventory walks the source. */
const INVENTORY_WRITE_BATCH = 200;
/** Pages read per store call while clustering. */
const CLUSTER_READ_BATCH = 1_000;
const MAX_ERROR_LENGTH = 500;

export interface CreateMigrationRunInput {
  readonly name?: string;
  readonly threshold?: number;
  readonly source: MigrationSourceInput;
}

export interface SiteMigrationDeps {
  readonly source: SiteSource;
  readonly blob: BlobStore;
}

/** What a run keeps in the blob store: page HTML, import script versions, and their outputs. */
export type MigrationArtifactKind = 'html' | 'script' | 'output';

const ARTIFACT_EXTENSION: Record<MigrationArtifactKind, string> = {
  html: 'html',
  script: 'js',
  output: 'json',
};

/** Where a run's artifact lives in the blob store, by its content's SHA-256. */
export function migrationArtifactKey(
  scope: Scope,
  runId: string,
  kind: MigrationArtifactKind,
  sha256: string,
): string {
  return `migrations/${scope.spaceId}/${scope.environmentId}/${runId}/${kind}/${sha256}.${ARTIFACT_EXTENSION[kind]}`;
}

export async function createMigrationRun(
  ctx: AppContext,
  scope: Scope,
  input: CreateMigrationRunInput,
): Promise<MigrationRun> {
  const source = checkMigrationSource(input.source);
  // Every request the run makes stays on this URL's origin, so screening it screens them all.
  assertSafeExternalUrl(source.url, 'source.url');
  const { name, threshold } = checkMigrationRunInput({ ...input, source });
  const at = ctx.clock.now().toISOString();
  const run: MigrationRun = {
    id: ctx.ids.newId(),
    name,
    source,
    status: 'created',
    threshold,
    inventory: null,
    error: null,
    releaseId: null,
    version: 1,
    createdAt: at,
    createdBy: ctx.actor ?? null,
    updatedAt: at,
  };
  await ctx.store.migrations.createRun(scope, run);
  return run;
}

export interface MigrationRunView {
  readonly run: MigrationRun;
  readonly pages: MigrationPageCounts;
  readonly templates: MigrationTemplate[];
}

export async function getMigrationRun(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<MigrationRunView> {
  const run = await requireRun(ctx, scope, id);
  const [pages, templates] = await Promise.all([
    ctx.store.migrations.countPages(scope, id),
    ctx.store.migrations.listTemplates(scope, id),
  ]);
  return { run, pages, templates };
}

/** Runs listed at most per call. */
export const MIGRATION_RUNS_MAX = 100;
const MIGRATION_RUNS_DEFAULT = 25;
/** Pages listed at most per call. */
export const MIGRATION_PAGES_MAX = 200;
const MIGRATION_PAGES_DEFAULT = 50;

/** The environment's runs, newest first. */
export async function listMigrationRuns(
  ctx: AppContext,
  scope: Scope,
  opts: { readonly limit?: number } = {},
): Promise<{ items: MigrationRun[] }> {
  const limit = clampLimit(opts.limit, MIGRATION_RUNS_DEFAULT, MIGRATION_RUNS_MAX);
  return { items: await ctx.store.migrations.listRuns(scope, { limit }) };
}

export interface MigrationPageListQuery {
  readonly stage?: MigrationPageStage;
  readonly templateId?: string;
  readonly limit?: number;
  /** `nextCursor` from the page before. */
  readonly cursor?: string;
}

/**
 * A page of the run's pages in discovery order, optionally of one stage or one template. A
 * `nextCursor` comes back only when more pages follow.
 */
export async function listMigrationPages(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  query: MigrationPageListQuery = {},
): Promise<{ items: MigrationPage[]; nextCursor?: string }> {
  await requireRun(ctx, scope, runId);
  if (query.stage !== undefined && !MIGRATION_PAGE_STAGES.includes(query.stage)) {
    throw new ValidationError([
      { field: 'stage', message: `must be one of ${MIGRATION_PAGE_STAGES.join(', ')}` },
    ]);
  }
  const limit = clampLimit(query.limit, MIGRATION_PAGES_DEFAULT, MIGRATION_PAGES_MAX);
  // One past the page says whether another follows, without a count.
  const found = await ctx.store.migrations.listPages(scope, runId, {
    limit: limit + 1,
    ...(query.stage ? { stage: query.stage } : {}),
    ...(query.templateId ? { templateId: query.templateId } : {}),
    ...(query.cursor ? { after: query.cursor } : {}),
  });
  const items = found.slice(0, limit);
  const last = items.at(-1);
  return found.length > limit && last ? { items, nextCursor: last.id } : { items };
}

/** The run's templates, largest first. */
export async function listMigrationTemplates(
  ctx: AppContext,
  scope: Scope,
  runId: string,
): Promise<{ items: MigrationTemplate[] }> {
  await requireRun(ctx, scope, runId);
  return { items: await ctx.store.migrations.listTemplates(scope, runId) };
}

/** A template as one read of it answers: the record, and where its pages stand against it. */
export interface MigrationTemplateDetail extends MigrationTemplate {
  /**
   * Once approved: its pages the transform would take (never transformed, or transformed by an
   * earlier approved version), and those loaded or published from an earlier one, which are left
   * as they are. Null while it isn't approved.
   */
  readonly pageVersions: { readonly toTransform: number; readonly loadedEarlier: number } | null;
}

/** One template of a run: its proposal, script version, last try, status and its pages' versions. */
export async function getMigrationTemplate(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  templateId: string,
): Promise<MigrationTemplateDetail> {
  await requireRun(ctx, scope, runId);
  const template = await ctx.store.migrations.getTemplate(scope, runId, templateId);
  if (!template) throw new NotFoundError('Migration template', templateId);
  if (template.status !== 'approved') return { ...template, pageVersions: null };
  const counts = await ctx.store.migrations.countOutputs(
    scope,
    runId,
    templateId,
    outputVersions(template),
  );
  let toTransform = 0;
  let loadedEarlier = 0;
  for (const { stage, pages, current } of counts) {
    if (stage === 'loaded' || stage === 'published') loadedEarlier += pages - current;
    else toTransform += pages - current;
  }
  return { ...template, pageVersions: { toTransform, loadedEarlier } };
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.trunc(limit), max));
}

/**
 * The site can't be read now: its robots.txt answered a server error or nothing. Nothing was
 * written; the step is safe to run again later.
 */
export class SiteUnavailableError extends DomainError {
  constructor(reason: string) {
    super('site_unavailable', `The site can't be read now: ${reason}`);
  }
}

/**
 * Walks the run's source and adds the pages it takes: a sitemap's pages, or a crawl's start
 * page. Pages are fetched after ({@link fetchSourcePages}), which is also how a crawl goes on.
 * Run again, it adds only pages the run doesn't hold.
 */
export async function inventorySite(
  ctx: AppContext,
  deps: SiteMigrationDeps,
  scope: Scope,
  runId: string,
): Promise<MigrationRun> {
  const run = await requireRun(ctx, scope, runId);
  if (run.status !== 'created' && run.status !== 'inventoried') {
    throw new InvalidStateError(`An inventory runs before clustering; the run is ${run.status}`);
  }
  const pending: DiscoveredPage[] = [];
  let added = 0;
  const flush = async () => {
    const batch = pending.splice(0);
    if (batch.length === 0) return;
    const known = new Set(
      await ctx.store.migrations.knownUrls(
        scope,
        runId,
        batch.map((p) => p.url),
      ),
    );
    const fresh = batch.filter((p) => !known.has(p.url)).map((p) => newPage(ctx, runId, p, 0));
    await ctx.store.migrations.addPages(scope, runId, fresh);
    added += fresh.length;
  };
  const report = await deps.source.discover(run.source, async (found) => {
    pending.push(found);
    if (pending.length >= INVENTORY_WRITE_BATCH) await flush();
  });
  if (report.unavailable) throw new SiteUnavailableError(report.unavailable);
  await flush();
  const inventory: MigrationInventory = {
    discovered: report.discovered,
    added,
    skipped: report.skipped,
    warnings: [...report.warnings],
  };
  const next: MigrationRun = {
    ...run,
    status: 'inventoried',
    inventory,
    version: run.version + 1,
    updatedAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.migrations.saveRun(scope, next, run.version);
  return next;
}

function newPage(
  ctx: AppContext,
  runId: string,
  found: DiscoveredPage,
  depth: number,
): MigrationPage {
  const at = ctx.clock.now().toISOString();
  return {
    id: ctx.ids.newId(),
    runId,
    url: found.url,
    path: new URL(found.url).pathname,
    depth,
    stage: 'discovered',
    templateId: null,
    title: null,
    lastModified: found.lastModified ?? null,
    httpStatus: null,
    html: null,
    fingerprint: null,
    output: null,
    outputScript: null,
    score: null,
    entryId: null,
    unresolvedLinks: 0,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** The page with a fetch's result: its HTML stored and read, or why there is none. */
async function withFetch(
  blob: BlobStore,
  scope: Scope,
  runId: string,
  page: MigrationPage,
  fetched: FetchedPage,
): Promise<MigrationPage> {
  if (!fetched.html) {
    return {
      ...page,
      httpStatus: fetched.status,
      error: (fetched.error ?? `answered ${fetched.status}`).slice(0, MAX_ERROR_LENGTH),
    };
  }
  const sha256 = sha256Hex(fetched.html);
  const key = migrationArtifactKey(scope, runId, 'html', sha256);
  await blob.put(key, fetched.html, 'text/html; charset=utf-8');
  const html: MigrationArtifact = {
    key,
    sha256,
    bytes: new TextEncoder().encode(fetched.html).byteLength,
  };
  const facts = readPageFacts(fetched.html);
  return {
    ...page,
    httpStatus: fetched.status,
    html,
    fingerprint: facts.fingerprint,
    title: facts.title,
    error: null,
  };
}

export interface FetchSourcePagesResult {
  readonly fetched: number;
  readonly failed: number;
  /** Pages a crawl found on this batch's pages and added. */
  readonly added: number;
  /** Whether pages are still waiting to be fetched: a Workflow loops while it is true. */
  readonly more: boolean;
  /**
   * Set when the site couldn't be read now (its robots.txt answered a server error or nothing):
   * nothing was written, and the same batch is waiting. Try again later.
   */
  readonly unavailable?: string;
}

/**
 * Fetches the next batch of the run's pages not fetched yet, stores their HTML and reads their
 * structure. A page that fails keeps the error and is not tried again by this step.
 *
 * For a crawl this is also the crawl: each fetched page's links that the run's globs take become
 * pages of the run one link deeper (to {@link MIGRATION_MAX_CRAWL_DEPTH}, while the run holds
 * fewer than `maxPages`), written in the same unit as the fetched pages. The run's pages are the
 * frontier, so a crawl stopped anywhere resumes from the pages still waiting.
 */
export async function fetchSourcePages(
  ctx: AppContext,
  deps: SiteMigrationDeps,
  scope: Scope,
  runId: string,
  opts: { readonly limit?: number } = {},
): Promise<FetchSourcePagesResult> {
  const run = await requireRun(ctx, scope, runId);
  const limit = Math.max(
    1,
    Math.min(opts.limit ?? MIGRATION_FETCH_BATCH_DEFAULT, MIGRATION_FETCH_BATCH_MAX),
  );
  const pages = await ctx.store.migrations.listPages(scope, runId, { fetch: 'pending', limit });
  if (pages.length === 0) return { fetched: 0, failed: 0, added: 0, more: false };
  const result = await deps.source.fetchPages(
    run.source,
    pages.map((p) => p.url),
  );
  if (result.unavailable) {
    return { fetched: 0, failed: 0, added: 0, more: true, unavailable: result.unavailable };
  }
  const at = ctx.clock.now().toISOString();
  const updated = await Promise.all(
    pages.map(async (page, i) => {
      const fetched = result.pages[i] ?? {
        url: page.url,
        status: 0,
        html: '',
        error: 'not fetched',
      };
      return withFetch(deps.blob, scope, runId, { ...page, updatedAt: at }, fetched);
    }),
  );
  const found =
    run.source.kind === 'crawl' ? await crawlFrontier(ctx, scope, run, pages, result.pages) : [];
  await ctx.store.withTransaction(async (tx) => {
    await tx.migrations.savePages(scope, runId, updated);
    await tx.migrations.addPages(scope, runId, found);
  });
  const failed = updated.filter((p) => p.error !== null).length;
  const rest = await ctx.store.migrations.listPages(scope, runId, { fetch: 'pending', limit: 1 });
  return { fetched: updated.length - failed, failed, added: found.length, more: rest.length > 0 };
}

/** The new pages a crawl batch leads to: unseen, taken by the globs, in depth and run limits. */
async function crawlFrontier(
  ctx: AppContext,
  scope: Scope,
  run: MigrationRun,
  pages: readonly MigrationPage[],
  fetched: readonly FetchedPage[],
): Promise<MigrationPage[]> {
  const candidates = new Map<string, number>();
  pages.forEach((page, i) => {
    if (page.depth >= MIGRATION_MAX_CRAWL_DEPTH) return;
    for (const url of fetched[i]?.links ?? []) {
      const path = new URL(url).pathname;
      if (!candidates.has(url) && sourceTakesPath(run.source, path)) {
        candidates.set(url, page.depth + 1);
      }
    }
  });
  if (candidates.size === 0) return [];
  const known = new Set(
    await ctx.store.migrations.knownUrls(scope, run.id, [...candidates.keys()]),
  );
  const room = run.source.maxPages - (await ctx.store.migrations.countPages(scope, run.id)).total;
  return [...candidates]
    .filter(([url]) => !known.has(url))
    .slice(0, Math.max(0, room))
    .map(([url, depth]) => newPage(ctx, run.id, { url }, depth));
}

/**
 * Groups the run's fetched pages into templates by structure, replacing any earlier grouping in
 * one unit with the run's compare-and-set: two clusterings at once can't leave a mix. Refused once
 * a template is past `pending` (being authored or approved), so authored work is never discarded.
 */
export async function clusterPages(
  ctx: AppContext,
  scope: Scope,
  runId: string,
  opts: { readonly threshold?: number } = {},
): Promise<MigrationRunView> {
  const run = await requireRun(ctx, scope, runId);
  if (run.status !== 'inventoried' && run.status !== 'clustered') {
    throw new InvalidStateError(`Pages are clustered after an inventory; the run is ${run.status}`);
  }
  const existing = await ctx.store.migrations.listTemplates(scope, runId);
  if (existing.some((t) => t.status !== 'pending')) {
    throw new InvalidStateError('A template is already being authored or approved');
  }
  const pages: { id: string; fingerprint: readonly string[] }[] = [];
  for (let after: string | undefined; ; ) {
    const batch = await ctx.store.migrations.listPages(scope, runId, {
      fetch: 'fetched',
      limit: CLUSTER_READ_BATCH,
      ...(after ? { after } : {}),
    });
    for (const p of batch) pages.push({ id: p.id, fingerprint: p.fingerprint ?? [] });
    if (batch.length < CLUSTER_READ_BATCH) break;
    after = batch.at(-1)?.id;
  }
  const at = ctx.clock.now().toISOString();
  const clusters: MigrationCluster[] = clusterByStructure(pages, opts.threshold).map((c, i) => ({
    template: {
      id: ctx.ids.newId(),
      runId,
      label: `Template ${i + 1}`,
      status: 'pending',
      pageCount: c.pageIds.length,
      samplePageIds: c.samplePageIds,
      fingerprint: c.fingerprint,
      contentTypeId: null,
      script: null,
      proposal: null,
      lastTry: null,
      approvedBy: null,
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
    pageIds: c.pageIds,
  }));
  const next: MigrationRun = {
    ...run,
    status: 'clustered',
    version: run.version + 1,
    updatedAt: at,
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.migrations.replaceTemplates(scope, runId, clusters, at);
    await tx.migrations.saveRun(scope, next, run.version);
  });
  return {
    run: next,
    pages: await ctx.store.migrations.countPages(scope, runId),
    templates: clusters.map((c) => c.template),
  };
}

async function requireRun(ctx: AppContext, scope: Scope, id: string): Promise<MigrationRun> {
  const run = await ctx.store.migrations.getRun(scope, id);
  if (!run) throw new NotFoundError('Migration run', id);
  return run;
}
