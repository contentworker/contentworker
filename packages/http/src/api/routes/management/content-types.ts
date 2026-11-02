import {
  countEntriesByContentType,
  createContentType,
  getContentType,
  getSpaceConfig,
  listContentTypes,
  publishContentType,
} from '@contentworker/application';
import { canAccessContentType, SCOPES } from '@contentworker/domain';
import { generateTypes } from '@contentworker/sdk-codegen';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as contentTypeDocs from '../../docs/schemas/content-types';
import { contentTypeBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function contentTypesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- space config (locales) --------------------------------------------
  app.get(`${BASE}/space-config`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getSpaceConfig(ctx, scopeOf(c))),
  );

  // --- content types ------------------------------------------------------
  app.get(
    `${BASE}/content-types`,
    doc('Content types', 'List content types', {
      description:
        '`?format=typescript` returns the content model as a TypeScript module instead of ' +
        'JSON — the same output the codegen CLI produces, served from the live model so CI ' +
        'and coding agents need nothing installed to type against it.',
      query: { format: 'json (default) | typescript' },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const types = await listContentTypes(ctx, scopeOf(c));
      if (c.req.query('format') !== 'typescript') return c.json({ items: types });

      // Served as text/plain rather than a TypeScript media type: browsers and
      // `curl` show it, and nothing downstream tries to execute it.
      return c.text(
        generateTypes(types as unknown as Parameters<typeof generateTypes>[0], {
          banner: `Generated from ${scopeOf(c).spaceId}/${scopeOf(c).environmentId} at ${ctx.clock
            .now()
            .toISOString()}. Do not edit by hand.`,
        }),
        200,
        { 'content-type': 'text/plain; charset=utf-8' },
      );
    },
  );
  app.post(
    `${BASE}/content-types`,
    doc('Content types', 'Create a content type', {
      body: contentTypeBody,
      ok: contentTypeDocs.contentType,
      status: 201,
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const ct = await createContentType(
        ctx,
        scopeOf(c),
        (await parseBody(c, contentTypeBody)) as unknown as Parameters<typeof createContentType>[2],
      );
      return c.json(ct, 201);
    },
  );
  // Before `/content-types/:apiId`, which would take "entry-counts" for an apiId (apiIds have no
  // hyphens, so no real type is shadowed).
  app.get(
    `${BASE}/content-types/entry-counts`,
    doc('Content types', 'Count entries per content type', {
      description:
        'Entries per content type by status (`draft`, `changed`, `published`, and `archived` ' +
        'for the trash), from one grouped count. `total` is the live entries, without the ' +
        'trash. Types the caller cannot read are left out.',
      ok: contentTypeDocs.contentTypeEntryCounts,
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const principal = c.get('principal');
      const counts = await countEntriesByContentType(ctx, scopeOf(c));
      return c.json({
        items: counts.filter((n) => canAccessContentType(principal, 'read', n.contentType)),
      });
    },
  );
  app.get(
    `${BASE}/content-types/:apiId`,
    doc('Content types', 'Get a content type', { ok: contentTypeDocs.contentType }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );
  app.post(
    `${BASE}/content-types/:apiId/published`,
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await publishContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );

  return app;
}
