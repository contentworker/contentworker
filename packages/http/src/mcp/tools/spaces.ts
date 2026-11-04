import { getLocaleSettings, listSpacesFor, setLocaleSettings } from '@contentworker/application';
import { authorize, SCOPES, SPACE_ID_PATTERN } from '@contentworker/domain';
import { createSpaceWithStarter, STARTERS } from '@contentworker/seed';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

export function registerSpaceTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, principal, guard } = t;
  // --- spaces (deployment) -------------------------------------------------
  server.registerTool(
    'spaces_list',
    {
      description:
        'List the spaces this credential can reach (every space for the deployment admin ' +
        'token; otherwise the one space the key or token belongs to), as { id, name }.',
      inputSchema: toolSchema('spaces_list', () => z.object({})),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const items = await listSpacesFor(ctx, principal);
      return ok({ items: items.map((s) => ({ id: s.spaceId, name: s.name })) });
    },
  );

  server.registerTool(
    'space_create',
    {
      description:
        'Create a space with its locales and environments (`main` by default). Deployment ' +
        'administrators only: a space’s own keys and tokens cannot create spaces. ' +
        '`starter: "sample"` also installs sample content into the first environment (a content ' +
        'model covering every field type, a few dozen entries, taxonomy, sample images and ' +
        'documents, one open release); "empty" (the default) creates it with nothing in it. ' +
        'An existing id is updated, not refused, and repeating a sample create finishes an ' +
        'install that failed part-way.',
      inputSchema: toolSchema('space_create', () =>
        z.object({
          spaceId: z
            .string()
            .regex(SPACE_ID_PATTERN)
            .describe(
              '1–64 letters, digits, ".", "_" or "-", starting with a letter or digit; not versions, imports, plugins or dlq (reserved)',
            ),
          name: z.string().max(256),
          defaultLocale: z.string().min(2).max(35),
          locales: z.array(z.string().min(2).max(35)).max(200).optional(),
          environments: z.array(z.string().min(1).max(128)).max(100).optional(),
          starter: z.enum(STARTERS).optional().describe('"empty" (default) or "sample"'),
        }),
      ),
    },
    async (args) => {
      // The same check as POST /spaces: space:admin across the deployment, not in one space.
      authorize(principal, SCOPES.spaceAdmin, '*');
      const created = await createSpaceWithStarter(ctx, args, { blob: deps.blob });
      return ok({
        id: created.space.spaceId,
        name: created.space.name,
        starter: created.starter,
        ...(created.installed ? { installed: created.installed } : {}),
      });
    },
  );

  // --- locale settings (space-wide) ------------------------------------------
  server.registerTool(
    'locale_settings_get',
    {
      description:
        'Read the space config: its default locale, locales and fallbacks, with each locale’s ' +
        'settings resolved in localeSettings: delivered (false: editors write and preview it, ' +
        'Delivery never serves it) and direction (ltr or rtl, from the language unless set).',
      inputSchema: toolSchema('locale_settings_get', () => z.object({ ...scopeArgs })),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getLocaleSettings(ctx, scopeOf(args)));
    },
  );

  server.registerTool(
    'locale_settings_set',
    {
      description:
        'Set per-locale settings: delivered (false takes the locale out of Delivery in every ' +
        'environment: a request naming it is 404, fallbacks skip it, all-locale responses and ' +
        'the sitemap leave it out; the default locale is always delivered) and direction (ltr or ' +
        'rtl). A locale left out keeps its settings. Needs space:admin.',
      inputSchema: toolSchema('locale_settings_set', () =>
        z.object({
          localeSettings: z.record(
            z.string(),
            z
              .object({
                delivered: z.boolean().optional(),
                direction: z.enum(['ltr', 'rtl']).optional(),
              })
              .strict(),
          ),
          ...scopeArgs,
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const s = scopeOf(args);
      guard(SCOPES.spaceAdmin, s);
      return ok(await setLocaleSettings(ctx, principal, s, args.localeSettings));
    },
  );
}
