import {
  clampCount,
  clusterPages,
  createMigrationRun,
  fetchSourcePages,
  getMigrationRun,
  inventorySite,
  listMigrationPages,
  listMigrationRuns,
  listMigrationTemplates,
  MIGRATION_PAGES_MAX,
  MIGRATION_RUNS_MAX,
  type SiteMigrationDeps,
} from '@contentworker/application';
import {
  MIGRATION_PAGE_STAGES,
  type MigrationPageStage,
  NotConfiguredError,
  SCOPES,
} from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireAnyScope, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as migrationDocs from '../../docs/schemas/migrations';
import {
  migrationPageResponse,
  migrationRunViewResponse,
  migrationTemplateResponse,
} from '../../migration-response';

import {
  MIGRATION_FETCH_REQUEST_MAX,
  migrationClusterBody,
  migrationFetchBody,
  migrationRunBody,
  parseBody,
} from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

const RUNS = `${BASE}/migrations/runs`;
const TAG = 'Site migration';

/**
 * Site migration, the steps before template authoring: create a run, inventory its source,
 * fetch its pages a bounded batch at a time, and cluster them into templates.
 *
 * Running a step needs `migration:run`: each one fetches from the source site. Reading a run back
 * needs `migration:run` or `content:manage`, so the people who will turn its templates into
 * content types can follow it without being able to make it fetch. Nothing here returns a page's
 * HTML: a page names its stored copy by hash and size.
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

  return app;
}
