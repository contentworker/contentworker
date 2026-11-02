import { listSpacesFor } from '@contentworker/application';
import { authorize, SCOPES, SPACE_ID_PATTERN } from '@contentworker/domain';
import { createSpaceWithStarter, STARTERS } from '@contentworker/seed';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ok, type ToolContext, toolSchema } from './shared';

export function registerSpaceTools(server: McpServer, t: ToolContext): void {
  const { deps, ctx, principal } = t;
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
}
