import {
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
  authorizeAny,
  MIGRATION_PAGE_STAGES,
  NotConfiguredError,
  type PermissionScope,
  SCOPES,
  type Scope,
} from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  migrationPageResponse,
  migrationRunViewResponse,
  migrationTemplateResponse,
} from '../../api/migration-response';
import {
  MIGRATION_FETCH_REQUEST_MAX,
  migrationClusterBody,
  migrationFetchBody,
  migrationRunBody,
} from '../../api/validation';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/**
 * Site migration, the steps before template authoring, as the HTTP API's `migrations` routes:
 * the same use-cases, the same scopes. Running a step needs `migration:run`; reading a run back
 * needs `migration:run` or `content:manage`. No tool returns a page's HTML.
 */
export function registerMigrationTools(server: McpServer, t: ToolContext): void {
  const { ctx, deps, guard } = t;
  const guardAny = (scopes: readonly PermissionScope[], s: Scope) =>
    authorizeAny(t.principal, scopes, s.spaceId);
  const site = (): SiteMigrationDeps => {
    if (!deps.siteSource || !deps.blob) {
      throw new NotConfiguredError('site_migration', 'Reading source sites is not configured');
    }
    return { source: deps.siteSource, blob: deps.blob };
  };
  const runArgs = { run: z.string().describe('The run id (migration_create returns it)') };

  server.registerTool(
    'migration_create',
    {
      description:
        'Start migrating a published website into this environment as structured content. ' +
        'source.kind "sitemap" reads a sitemap (or the origin: robots.txt Sitemap lines, then ' +
        '/sitemap.xml); "crawl" follows same-origin links from source.url. include/exclude are ' +
        'path globs (* within a segment, ** across). Every request stays on the URL’s origin and ' +
        'keeps to its robots.txt; loopback, link-local and private addresses are refused. ' +
        'Fetches nothing yet: then migration_inventory.',
      inputSchema: toolSchema('migration_create', () =>
        z.object({ ...migrationRunBody.shape, ...scopeArgs }),
      ),
    },
    async (args) => {
      guard(SCOPES.migrationRun, scopeOf(args));
      const { space: _space, environment: _environment, ...input } = args;
      return ok(await createMigrationRun(ctx, scopeOf(args), input));
    },
  );

  server.registerTool(
    'migration_list',
    {
      description: 'List the environment’s migration runs, newest first.',
      inputSchema: toolSchema('migration_list', () =>
        z.object({
          limit: z.number().int().min(1).max(MIGRATION_RUNS_MAX).optional(),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guardAny([SCOPES.migrationRun, SCOPES.contentManage], scopeOf(args));
      return ok(
        await listMigrationRuns(
          ctx,
          scopeOf(args),
          args.limit !== undefined ? { limit: args.limit } : {},
        ),
      );
    },
  );

  server.registerTool(
    'migration_status',
    {
      description:
        'A migration run: its status (the step that last finished: created, inventoried, ' +
        'clustered), what its inventory found and skipped, page counts by stage, and its ' +
        'templates, largest first.',
      inputSchema: toolSchema('migration_status', () => z.object({ ...runArgs, ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guardAny([SCOPES.migrationRun, SCOPES.contentManage], scopeOf(args));
      return ok(migrationRunViewResponse(await getMigrationRun(ctx, scopeOf(args), args.run)));
    },
  );

  server.registerTool(
    'migration_inventory',
    {
      description:
        'Walk the run’s source and add the pages it takes: every page a sitemap lists (to ' +
        'maxPages), or a crawl’s start page. Pages robots.txt disallows are counted, not added. ' +
        'Safe to repeat (only new URLs are added). Refused once the run is clustered. A ' +
        'site_unavailable error means robots.txt could not be read: nothing was written, try ' +
        'later. Then migration_fetch_pages.',
      inputSchema: toolSchema('migration_inventory', () => z.object({ ...runArgs, ...scopeArgs })),
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      guard(SCOPES.migrationRun, scopeOf(args));
      return ok(await inventorySite(ctx, site(), scopeOf(args), args.run));
    },
  );

  server.registerTool(
    'migration_fetch_pages',
    {
      description:
        'Fetch the next batch of the run’s pages not fetched yet and store their HTML (never ' +
        'returned). A crawl adds the same-origin links it finds. Call again while `more` is ' +
        'true; a failed page keeps its error and is skipped after. With `unavailable` set, ' +
        'nothing was written: wait and call again. Then migration_cluster.',
      inputSchema: toolSchema('migration_fetch_pages', () =>
        z.object({ ...runArgs, ...migrationFetchBody.shape, ...scopeArgs }),
      ),
      annotations: { openWorldHint: true },
    },
    async (args) => {
      guard(SCOPES.migrationRun, scopeOf(args));
      return ok(
        await fetchSourcePages(ctx, site(), scopeOf(args), args.run, {
          limit: args.limit ?? MIGRATION_FETCH_REQUEST_MAX,
        }),
      );
    },
  );

  server.registerTool(
    'migration_cluster',
    {
      description:
        'Group the run’s fetched pages into templates by HTML structure, replacing any earlier ' +
        'grouping. A lower threshold makes fewer, broader templates. Refused before an ' +
        'inventory and once a template is being authored or approved. Then migration_templates.',
      inputSchema: toolSchema('migration_cluster', () =>
        z.object({ ...runArgs, ...migrationClusterBody.shape, ...scopeArgs }),
      ),
      annotations: { idempotentHint: true },
    },
    async (args) => {
      guard(SCOPES.migrationRun, scopeOf(args));
      return ok(
        migrationRunViewResponse(
          await clusterPages(
            ctx,
            scopeOf(args),
            args.run,
            args.threshold !== undefined ? { threshold: args.threshold } : {},
          ),
        ),
      );
    },
  );

  server.registerTool(
    'migration_pages',
    {
      description:
        'List a run’s pages in discovery order (paged by cursor): URL, title, stage, template, ' +
        'HTTP status, error. Filter by stage or template; pages with an error and no HTML are ' +
        'the ones a fetch could not read.',
      inputSchema: toolSchema('migration_pages', () =>
        z.object({
          ...runArgs,
          stage: z.enum(MIGRATION_PAGE_STAGES).optional(),
          template: z.string().optional().describe('One template’s pages'),
          limit: z.number().int().min(1).max(MIGRATION_PAGES_MAX).optional(),
          cursor: z.string().optional().describe('nextCursor from the previous call'),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guardAny([SCOPES.migrationRun, SCOPES.contentManage], scopeOf(args));
      const page = await listMigrationPages(ctx, scopeOf(args), args.run, {
        ...(args.stage ? { stage: args.stage } : {}),
        ...(args.template ? { templateId: args.template } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
      });
      return ok({ ...page, items: page.items.map(migrationPageResponse) });
    },
  );

  server.registerTool(
    'migration_templates',
    {
      description:
        'List a run’s templates, largest first: each a set of pages sharing one structure, ' +
        'with its page count and sample page ids (read them with migration_pages).',
      inputSchema: toolSchema('migration_templates', () => z.object({ ...runArgs, ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guardAny([SCOPES.migrationRun, SCOPES.contentManage], scopeOf(args));
      const { items } = await listMigrationTemplates(ctx, scopeOf(args), args.run);
      return ok({ items: items.map(migrationTemplateResponse) });
    },
  );
}
