import {
  approveMigrationPublish,
  approveMigrationTemplate,
  clampCount,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  getImportScript,
  getMigrationRun,
  getMigrationTemplate,
  importMigrationRedirects,
  inventorySite,
  listMigrationPages,
  listMigrationRuns,
  listMigrationTemplates,
  loadTemplatePages,
  MIGRATION_PAGES_MAX,
  MIGRATION_RUNS_MAX,
  type MigrationLoadDeps,
  proposeTemplateModel,
  publishMigration,
  relinkMigratedPages,
  type SiteMigrationDeps,
  setImportScript,
  startMigration,
  type TemplateAuthoringDeps,
  transformTemplatePages,
  tryImportScript,
} from '@contentworker/application';
import {
  authorize,
  type ContentTypeDraft,
  MIGRATION_PAGE_STAGES,
  type MigrationPageStage,
  NotConfiguredError,
  type Principal,
  SCOPES,
} from '@contentworker/domain';
import type { MigrationRunner } from '@contentworker/ports';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireAnyScope, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as migrationDocs from '../../docs/schemas/migrations';
import {
  migrationApprovalResponse,
  migrationPageResponse,
  migrationRunViewResponse,
  migrationScriptResponse,
  migrationTemplateResponse,
  migrationTryResponse,
} from '../../migration-response';
import {
  MIGRATION_FETCH_REQUEST_MAX,
  MIGRATION_LOAD_REQUEST_MAX,
  MIGRATION_PUBLISH_REQUEST_MAX,
  MIGRATION_RELINK_REQUEST_MAX,
  MIGRATION_TRANSFORM_REQUEST_MAX,
  migrationApproveBody,
  migrationClusterBody,
  migrationFetchBody,
  migrationLoadBody,
  migrationProposalBody,
  migrationPublishApprovalBody,
  migrationPublishBody,
  migrationRedirectsBody,
  migrationRelinkBody,
  migrationRunBody,
  migrationScriptBody,
  migrationTransformBody,
  migrationTryBody,
  parseBody,
} from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

const RUNS = `${BASE}/migrations/runs`;
const TAG = 'Site migration';

/**
 * Site migration: create a run, inventory its source, fetch its pages, cluster them into
 * templates, author each template (propose its model, write and try its import script), approve
 * it, transform and load its pages, relink, redirect and publish. Each step that writes goes a
 * bounded batch per request; `…/start` hands the whole run to the engine's driver instead, which
 * is how a large site goes.
 *
 * Running a step needs `migration:run`: the early ones fetch from the source site, the authoring
 * ones run scripts. Reading a run back needs `migration:run` or `content:manage`, so the people
 * who will approve its templates can follow it without being able to make it fetch. Each step
 * that writes content needs what that write needs as well: approving `content:manage`, loading
 * `content:write` and `assets:write`, relinking `content:write`, redirects `content:manage`, and
 * publishing `content:publish` (and `content:write` through a release). The use-cases check those
 * again. Who acts is the authenticated caller, never a value from the body.
 *
 * Nothing here returns a page's HTML: a page names its stored copy by hash and size, and a
 * script's output leaves with its `$html` fragments resolved to rich text.
 */
export function migrationsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();
  const readScopes = requireAnyScope(SCOPES.migrationRun, SCOPES.contentManage);
  const site = (): SiteMigrationDeps => {
    if (!deps.siteSource) {
      throw new NotConfiguredError('site_migration', 'Reading source sites is not configured');
    }
    return { source: deps.siteSource, blob: deps.blob };
  };
  const authoring = (): TemplateAuthoringDeps => {
    if (!deps.importScriptSandbox) {
      throw new NotConfiguredError('import_scripts', 'Running import scripts is not configured');
    }
    return { blob: deps.blob, sandbox: deps.importScriptSandbox };
  };
  const loading = (): MigrationLoadDeps => {
    if (!deps.remoteFetcher) {
      throw new NotConfiguredError(
        'site_migration',
        'Downloading a page’s assets is not configured',
      );
    }
    return {
      blob: deps.blob,
      fetcher: deps.remoteFetcher,
      ...(deps.assetIngest ? { ingest: deps.assetIngest } : {}),
    };
  };
  const runner = (): MigrationRunner => {
    if (!deps.migrationRunner) {
      throw new NotConfiguredError(
        'migration_runner',
        'Running migrations in the background is not configured',
      );
    }
    return deps.migrationRunner;
  };
  const TEMPLATE = `${RUNS}/:id/templates/:template`;
  const ref = (c: { req: { param(name: string): string } }) => ({
    runId: c.req.param('id'),
    templateId: c.req.param('template'),
  });

  app.post(
    RUNS,
    doc(TAG, 'Create a migration run', {
      body: migrationRunBody,
      ok: migrationDocs.migrationRun,
      status: 201,
      description:
        'Nothing is fetched yet. 422 for a malformed source, or a URL on a loopback, link-local ' +
        'or private address; every request the run makes stays on that URL’s origin.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) =>
      c.json(
        await createMigrationRun(
          actingCtx(ctx, c),
          scopeOf(c),
          await parseBody(c, migrationRunBody),
        ),
        201,
      ),
  );
  app.get(
    RUNS,
    doc(TAG, 'List migration runs', {
      ok: migrationDocs.migrationRunList,
      description: 'Newest first.',
      query: { limit: `Most runs, 1..${MIGRATION_RUNS_MAX} (default 25)` },
    }),
    readScopes,
    async (c) => {
      const limit = clampCount(c.req.query('limit'), MIGRATION_RUNS_MAX, { min: 1 });
      return c.json(await listMigrationRuns(ctx, scopeOf(c), limit !== undefined ? { limit } : {}));
    },
  );
  app.get(
    `${RUNS}/:id`,
    doc(TAG, 'Get a migration run', {
      ok: migrationDocs.migrationRunView,
      description: 'The run, its page counts by stage, and its templates.',
    }),
    readScopes,
    async (c) =>
      c.json(migrationRunViewResponse(await getMigrationRun(ctx, scopeOf(c), c.req.param('id')))),
  );
  app.post(
    `${RUNS}/:id/inventory`,
    doc(TAG, 'Inventory the run’s source', {
      ok: migrationDocs.migrationRun,
      description:
        'A sitemap source adds every page it lists that the globs take, up to maxPages; a crawl ' +
        'adds its start page, and the fetch step follows links. Pages robots.txt disallows are ' +
        'left out and counted. Safe to repeat: only new URLs are added. 400 (`invalid_state`) ' +
        'once the run is clustered; 503 (`site_unavailable`, nothing written) while the site’s ' +
        'robots.txt answers a server error or nothing; 409 (`retryable`) when another step ' +
        'wrote the run first.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => c.json(await inventorySite(ctx, site(), scopeOf(c), c.req.param('id'))),
  );
  app.post(
    `${RUNS}/:id/fetch`,
    doc(TAG, 'Fetch a batch of the run’s pages', {
      body: migrationFetchBody,
      ok: migrationDocs.migrationFetchResult,
      description:
        `Fetches up to \`limit\` (default and most ${MIGRATION_FETCH_REQUEST_MAX}) pages not fetched yet, ` +
        'keeping to robots.txt and its crawl delay, and stores their HTML. Call again while ' +
        '`more` is true. A crawl adds the links it finds here. A page that fails keeps its error ' +
        'and is not tried again. With `unavailable` set nothing was written: try again later.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => {
      const body = await parseBody(c, migrationFetchBody);
      return c.json(
        await fetchSourcePages(ctx, site(), scopeOf(c), c.req.param('id'), {
          limit: body.limit ?? MIGRATION_FETCH_REQUEST_MAX,
        }),
      );
    },
  );
  app.post(
    `${RUNS}/:id/cluster`,
    doc(TAG, 'Cluster the run’s pages into templates', {
      body: migrationClusterBody,
      ok: migrationDocs.migrationRunView,
      description:
        'Groups the fetched pages by structure, replacing any earlier grouping whole. 400 ' +
        '(`invalid_state`) before an inventory, or once a template is being authored or ' +
        'approved; 409 (`retryable`) when another clustering won.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => {
      const body = await parseBody(c, migrationClusterBody);
      return c.json(
        migrationRunViewResponse(
          await clusterPages(
            ctx,
            scopeOf(c),
            c.req.param('id'),
            body.threshold !== undefined ? { threshold: body.threshold } : {},
          ),
        ),
      );
    },
  );
  app.get(
    `${RUNS}/:id/pages`,
    doc(TAG, 'List a run’s pages', {
      ok: migrationDocs.migrationPageList,
      description:
        'In discovery order. Page with the response’s nextCursor, present only while more follow.',
      query: {
        stage: `One stage: ${MIGRATION_PAGE_STAGES.join(', ')}`,
        template: 'One template’s pages',
        limit: `Page size, 1..${MIGRATION_PAGES_MAX} (default 50)`,
        cursor: 'nextCursor from the previous page',
      },
    }),
    readScopes,
    async (c) => {
      const limit = clampCount(c.req.query('limit'), MIGRATION_PAGES_MAX, { min: 1 });
      const stage = c.req.query('stage');
      const templateId = c.req.query('template');
      const cursor = c.req.query('cursor');
      const page = await listMigrationPages(ctx, scopeOf(c), c.req.param('id'), {
        ...(stage ? { stage: stage as MigrationPageStage } : {}),
        ...(templateId ? { templateId } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return c.json({ ...page, items: page.items.map(migrationPageResponse) });
    },
  );
  app.get(
    `${RUNS}/:id/templates`,
    doc(TAG, 'List a run’s templates', {
      ok: migrationDocs.migrationTemplateList,
      description: 'Largest first, each with its sample pages.',
    }),
    readScopes,
    async (c) => {
      const { items } = await listMigrationTemplates(ctx, scopeOf(c), c.req.param('id'));
      return c.json({ items: items.map(migrationTemplateResponse) });
    },
  );

  // --- authoring ------------------------------------------------------------
  app.get(
    TEMPLATE,
    doc(TAG, 'Get a template', {
      ok: migrationDocs.migrationTemplate,
      description:
        'Its status, proposed model, script version and last try, and `reviewDigest`: what ' +
        '`reviewed` names when approving it.',
    }),
    readScopes,
    async (c) => {
      const { runId, templateId } = ref(c);
      return c.json(
        migrationTemplateResponse(await getMigrationTemplate(ctx, scopeOf(c), runId, templateId)),
      );
    },
  );
  app.post(
    `${TEMPLATE}/proposal`,
    doc(TAG, 'Propose a template’s content model', {
      body: migrationProposalBody,
      ok: migrationDocs.migrationTemplate,
      description:
        'Checked as the type will be created: a unique `sourceUrl` field (added when left out), ' +
        'exactly one top-level blocks field for the body, and a URL pattern. Preview, agent ' +
        'instructions, layout and field help are dropped. Nothing in the model changes until ' +
        'the template is approved. 400 (`invalid_state`) once it is being approved or approved.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => {
      const { model } = await parseBody(c, migrationProposalBody);
      return c.json(
        migrationTemplateResponse(
          await proposeTemplateModel(actingCtx(ctx, c), scopeOf(c), {
            ...ref(c),
            // The envelope only: `checkTemplateModel` checks the definition, as a type save does.
            model: model as unknown as ContentTypeDraft,
          }),
        ),
      );
    },
  );
  app.get(
    `${TEMPLATE}/script`,
    doc(TAG, 'Read a template’s import script', {
      ok: migrationDocs.migrationScript,
      description: 'The script as text, and its SHA-256; both null before one is written.',
    }),
    readScopes,
    async (c) =>
      c.json(
        migrationScriptResponse(
          await getImportScript(ctx, { blob: deps.blob }, scopeOf(c), ref(c)),
        ),
      ),
  );
  app.put(
    `${TEMPLATE}/script`,
    doc(TAG, 'Write a template’s import script', {
      body: migrationScriptBody,
      ok: migrationDocs.migrationTemplate,
      description:
        'Stores a new version (at most 256 KiB) without running it; try it next. A new version ' +
        'changes the template’s `reviewDigest`. 400 (`invalid_state`) once it is being approved.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => {
      const { script } = await parseBody(c, migrationScriptBody);
      return c.json(
        migrationTemplateResponse(
          await setImportScript(actingCtx(ctx, c), { blob: deps.blob }, scopeOf(c), {
            ...ref(c),
            script,
          }),
        ),
      );
    },
  );
  app.post(
    `${TEMPLATE}/try`,
    doc(TAG, 'Try a template’s import script', {
      body: migrationTryBody,
      ok: migrationDocs.migrationTryResult,
      description:
        'Runs the stored script (or `script`, not stored) on the sample pages or up to five ' +
        'given ones, in an isolate with no network, checks each output against the model and ' +
        'scores it. Outputs come back with `$html` resolved to rich text. Only the summary is ' +
        'kept, as the template’s `lastTry`. 501 where scripts can’t run.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => {
      const body = await parseBody(c, migrationTryBody);
      return c.json(
        migrationTryResponse(
          await tryImportScript(ctx, authoring(), scopeOf(c), {
            ...ref(c),
            ...(body.script !== undefined ? { script: body.script } : {}),
            ...(body.pageIds ? { pageIds: body.pageIds } : {}),
          }),
        ),
      );
    },
  );
  app.post(
    `${TEMPLATE}/approve`,
    doc(TAG, 'Approve a template', {
      body: migrationApproveBody,
      ok: migrationDocs.migrationApproval,
      description:
        'Needs `content:manage`. Creates and publishes the content type from the proposal, as ' +
        'you, and approves the template; then tells the run’s driver, when it has one ' +
        '(`signalled`). 409 when the template changed since the `reviewDigest` you name, or an ' +
        'unrelated type has its apiId. Approving an approved template answers it again, and ' +
        'tells the driver again.',
    }),
    readScopes,
    async (c) => {
      const { reviewed } = await parseBody(c, migrationApproveBody);
      return c.json(
        migrationApprovalResponse(
          await approveMigrationTemplate(
            actingCtx(ctx, c),
            deps.migrationRunner,
            c.get('principal'),
            scopeOf(c),
            { ...ref(c), reviewed },
          ),
        ),
      );
    },
  );

  // --- transform and load ---------------------------------------------------
  app.post(
    `${TEMPLATE}/transform`,
    doc(TAG, 'Transform a batch of an approved template’s pages', {
      body: migrationTransformBody,
      ok: migrationDocs.migrationTransformResult,
      description:
        `Runs the approved script on up to \`limit\` (default and most ${MIGRATION_TRANSFORM_REQUEST_MAX}) ` +
        'pages after `after`, scores each and moves it to `validated` or `needs-fix`. Call ' +
        'again with `next` while `more` is true. Pages already transformed by this script ' +
        'version are skipped. For a whole site, use `…/start`.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) => {
      const body = await parseBody(c, migrationTransformBody);
      return c.json(
        await transformTemplatePages(ctx, authoring(), scopeOf(c), {
          ...ref(c),
          batchSize: body.limit ?? MIGRATION_TRANSFORM_REQUEST_MAX,
          ...(body.after ? { after: body.after } : {}),
        }),
      );
    },
  );
  app.post(
    `${TEMPLATE}/load`,
    doc(TAG, 'Load a batch of an approved template’s pages as entries', {
      body: migrationLoadBody,
      ok: migrationDocs.migrationLoadResult,
      description:
        'Needs `content:write` and `assets:write` too. Brings in the assets each output names ' +
        'and writes the entries as you, matched on `sourceUrl` (loading a page again updates ' +
        `its entry). Up to \`limit\` (default and most ${MIGRATION_LOAD_REQUEST_MAX}) pages; call ` +
        'again while `more` is true. A refused page moves to `needs-fix` with the reason.',
    }),
    requireScope(SCOPES.migrationRun),
    requireScope(SCOPES.contentWrite),
    requireScope(SCOPES.assetsWrite),
    async (c) => {
      const body = await parseBody(c, migrationLoadBody);
      return c.json(
        await loadTemplatePages(actingCtx(ctx, c), loading(), c.get('principal'), scopeOf(c), {
          ...ref(c),
          batchSize: body.limit ?? MIGRATION_LOAD_REQUEST_MAX,
          ...(body.includeNeedsFix ? { includeNeedsFix: true } : {}),
        }),
      );
    },
  );
  app.post(
    `${RUNS}/:id/relink`,
    doc(TAG, 'Relink a batch of the run’s loaded entries', {
      body: migrationRelinkBody,
      ok: migrationDocs.migrationRelinkResult,
      description:
        'Needs `content:write` too. Points links between migrated pages at the entries they ' +
        'became, saving only entries that changed (an entry edited since is skipped). Call ' +
        'again with `next` until it is absent.',
    }),
    requireScope(SCOPES.migrationRun),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, migrationRelinkBody);
      return c.json(
        await relinkMigratedPages(actingCtx(ctx, c), c.get('principal'), scopeOf(c), {
          runId: c.req.param('id'),
          batchSize: body.limit ?? MIGRATION_RELINK_REQUEST_MAX,
          ...(body.after ? { after: body.after } : {}),
        }),
      );
    },
  );
  app.post(
    `${RUNS}/:id/redirects`,
    doc(TAG, 'Redirect the run’s old URLs to its entries', {
      body: migrationRedirectsBody,
      ok: migrationDocs.migrationRedirectsResult,
      description:
        'Needs `content:manage`. A 301 from each loaded page’s old path to its entry’s path by ' +
        'the type’s URL pattern, upserted by source. Safe to repeat: a second run is all ' +
        '`unchanged`.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, migrationRedirectsBody);
      return c.json(
        await importMigrationRedirects(actingCtx(ctx, c), c.get('principal'), scopeOf(c), {
          runId: c.req.param('id'),
          ...(body.template ? { templateId: body.template } : {}),
        }),
      );
    },
  );
  app.post(
    `${RUNS}/:id/publish`,
    doc(TAG, 'Publish a batch of the run’s loaded entries', {
      body: migrationPublishBody,
      ok: migrationDocs.migrationPublishResult,
      description:
        'Needs `content:publish` (and `publish` on each type); through a release ' +
        '(`viaRelease`), `content:write` too, and every loaded entry is added in this one ' +
        `call. Publishing takes up to \`limit\` (default and most ${MIGRATION_PUBLISH_REQUEST_MAX}) ` +
        'pages; call again with `next`. For a run its driver runs, send ' +
        '`…/publish-approval` instead.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const body = await parseBody(c, migrationPublishBody);
      if (body.viaRelease) requireWrite(c.get('principal'), scopeOf(c).spaceId);
      return c.json(
        await publishMigration(actingCtx(ctx, c), c.get('principal'), scopeOf(c), {
          runId: c.req.param('id'),
          ...(body.template ? { templateId: body.template } : {}),
          ...(body.viaRelease ? { viaRelease: true } : {}),
          ...(body.releaseId ? { releaseId: body.releaseId } : {}),
          ...(body.releaseTitle ? { releaseTitle: body.releaseTitle } : {}),
          batchSize: body.limit ?? MIGRATION_PUBLISH_REQUEST_MAX,
          ...(body.after ? { after: body.after } : {}),
        }),
      );
    },
  );

  // --- the driver -----------------------------------------------------------
  app.post(
    `${RUNS}/:id/start`,
    doc(TAG, 'Run the migration in the background', {
      ok: migrationDocs.migrationStartResult,
      status: 202,
      description:
        'Starts the run’s driver in the engine, acting for you: it inventories, fetches and ' +
        'clusters, starts an authoring agent per template, waits for each template’s approval, ' +
        'transforms, loads, redirects and relinks, then waits for `…/publish-approval`. The way ' +
        'to migrate a large site. Safe to repeat: `started` is false when it was running ' +
        'already. 501 where the engine’s driver isn’t bound.',
    }),
    requireScope(SCOPES.migrationRun),
    async (c) =>
      c.json(
        await startMigration(ctx, runner(), c.get('principal'), scopeOf(c), c.req.param('id')),
        202,
      ),
  );
  app.post(
    `${RUNS}/:id/publish-approval`,
    doc(TAG, 'Give the run’s driver the go-ahead to publish', {
      body: migrationPublishApprovalBody,
      ok: migrationDocs.migrationPublishApproval,
      status: 202,
      description:
        'Needs `content:publish`, and `content:write` through a release. The driver publishes ' +
        'as you once its pages are loaded (or adds them to a release). 404 when the run has no ' +
        'driver (`…/start` it, or publish with `…/publish`).',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const body = await parseBody(c, migrationPublishApprovalBody);
      if (body.viaRelease) requireWrite(c.get('principal'), scopeOf(c).spaceId);
      await approveMigrationPublish(ctx, runner(), c.get('principal'), scopeOf(c), {
        runId: c.req.param('id'),
        ...body,
      });
      return c.json({ accepted: true as const }, 202);
    },
  );

  return app;
}

/** `content:write` as well, for a publish that goes through a release (as making one needs). */
function requireWrite(principal: Principal, spaceId: string): void {
  authorize(principal, SCOPES.contentWrite, spaceId);
}
