import {
  checkMigrationRunInput,
  checkMigrationSource,
  clusterByStructure,
  InvalidStateError,
  type MigrationArtifact,
  type MigrationInventory,
  type MigrationPage,
  type MigrationRun,
  type MigrationSourceInput,
  type MigrationTemplate,
  NotFoundError,
  readPageFacts,
  type Scope,
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
import { sha256Hex } from './token-crypto';
import { assertSafeExternalUrl } from './url-safety';

/**
 * Site migration, the first steps: create a run, inventory its source, fetch its pages, and
 * cluster them into templates. Each step is safe to run again (a redelivered Workflow step): an
 * inventory adds only URLs the run doesn't have, a fetch takes only pages not fetched yet, and a
 * clustering replaces the run's templates whole at the run's compare-and-set.
 *
 * Page HTML goes to the blob store, content-addressed under the run
 * (`migrations/<space>/<environment>/<run>/html/<sha256>.html`): a step repeated with the same
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

/** Where a run's artifact lives in the blob store. */
export function migrationArtifactKey(
  scope: Scope,
  runId: string,
  kind: 'html',
  sha256: string,
): string {
  return `migrations/${scope.spaceId}/${scope.environmentId}/${runId}/${kind}/${sha256}.${kind}`;
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

/**
 * Walks the run's source and adds the pages it takes. A crawl fetched its pages on the way, so
 * their HTML is stored with them; a sitemap's pages are fetched after ({@link fetchSourcePages}).
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
  const before = (await ctx.store.migrations.countPages(scope, runId)).total;
  const pending: MigrationPage[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    await ctx.store.migrations.addPages(scope, runId, pending.splice(0));
  };
  const report = await deps.source.discover(run.source, async (found: DiscoveredPage) => {
    pending.push(await discoveredPage(ctx, deps.blob, scope, runId, found));
    if (pending.length >= INVENTORY_WRITE_BATCH) await flush();
  });
  await flush();
  // Counted, not tallied: a page the run already held is handed over again but not added.
  const added = (await ctx.store.migrations.countPages(scope, runId)).total - before;
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

async function discoveredPage(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  runId: string,
  found: DiscoveredPage,
): Promise<MigrationPage> {
  const at = ctx.clock.now().toISOString();
  const base: MigrationPage = {
    id: ctx.ids.newId(),
    runId,
    url: found.url,
    path: new URL(found.url).pathname,
    stage: 'discovered',
    templateId: null,
    title: null,
    lastModified: found.lastModified ?? null,
    httpStatus: null,
    html: null,
    fingerprint: null,
    output: null,
    score: null,
    entryId: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
  return found.fetched ? withFetch(blob, scope, runId, base, found.fetched) : base;
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
  /** Whether pages are still waiting to be fetched. */
  readonly more: boolean;
}

/**
 * Fetches the next batch of the run's pages not fetched yet, stores their HTML and reads their
 * structure. A page that fails keeps the error and is not tried again by this step.
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
  if (pages.length === 0) return { fetched: 0, failed: 0, more: false };
  const results = await deps.source.fetchPages(
    run.source,
    pages.map((p) => p.url),
  );
  const at = ctx.clock.now().toISOString();
  const updated = await Promise.all(
    pages.map(async (page, i) => {
      const fetched = results[i] ?? { url: page.url, status: 0, html: '', error: 'not fetched' };
      return withFetch(deps.blob, scope, runId, { ...page, updatedAt: at }, fetched);
    }),
  );
  await ctx.store.migrations.savePages(scope, runId, updated);
  const failed = updated.filter((p) => p.error !== null).length;
  const rest = await ctx.store.migrations.listPages(scope, runId, { fetch: 'pending', limit: 1 });
  return { fetched: updated.length - failed, failed, more: rest.length > 0 };
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
