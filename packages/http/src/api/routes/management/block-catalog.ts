import {
  getBlockCatalog,
  getBlockUsage,
  listBlockCatalogVersions,
  MAX_BLOCK_CATALOG_VERSIONS_PAGE,
  MAX_BLOCK_USAGE_SCAN,
  pushBlockCatalog,
} from '@contentworker/application';
import { SCOPES, ValidationError } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as blockCatalogDocs from '../../docs/schemas/block-catalog';
import { blockCatalogPushBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

/** A version in a path or query: a positive integer, else undefined when absent. */
function versionOf(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError([{ field: name, message: 'A version is a positive integer' }]);
  }
  return n;
}

/**
 * Blocks from code: the block catalog a developer pushes (`contentworker blocks push`), its
 * version history, and how much each block is used. Under `/block-catalog`, apart from the entry
 * routes that address one block inside an entry.
 */
export function blockCatalogRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/block-catalog`,
    doc('Block catalog', 'Get the block catalog', {
      ok: blockCatalogDocs.blockCatalog,
      description:
        'The catalog in force: every block manifest, the blocks fields it provides, and who ' +
        'pushed it when. 404 before the first push.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getBlockCatalog(ctx, scopeOf(c))),
  );
  app.post(
    `${BASE}/block-catalog`,
    doc('Block catalog', 'Push a block catalog', {
      body: blockCatalogPushBody,
      ok: blockCatalogDocs.blockCatalogPush,
      description:
        'Makes the targets’ blocks fields take exactly the catalog’s blocks as variants (slots ' +
        'become nested blocks fields), revising each changed type with the content model’s ' +
        'rules and publishing it unless `publish` is false, and stores the catalog as a new ' +
        'version, in one unit. `dryRun` answers what it would do and changes nothing; pushing ' +
        'the catalog in force again writes nothing. 422 naming each problem in the manifests. ' +
        '409 when `expectedVersion` is stale, when it removes a block or block prop that an ' +
        'entry still holds (keep the old id in the new block’s `aliases` to rename instead), ' +
        'when it removes anything without `allowDestructive`, or when another push commits ' +
        'first; the push result rides in `details`.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await pushBlockCatalog(
          ctx,
          c.get('principal'),
          scopeOf(c),
          await parseBody(c, blockCatalogPushBody),
        ),
      ),
  );
  // Before `/block-catalog/versions/:version`.
  app.get(
    `${BASE}/block-catalog/versions`,
    doc('Block catalog', 'List block catalog versions', {
      ok: blockCatalogDocs.blockCatalogVersions,
      description: 'Pushed versions, newest first, without their blocks.',
      query: {
        limit: `Page size (default 20, at most ${MAX_BLOCK_CATALOG_VERSIONS_PAGE})`,
        before: 'Only versions below this one: the last version of the previous page',
      },
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const limit = versionOf(c.req.query('limit'), 'limit');
      const before = versionOf(c.req.query('before'), 'before');
      return c.json({
        items: await listBlockCatalogVersions(ctx, scopeOf(c), {
          ...(limit !== undefined ? { limit } : {}),
          ...(before !== undefined ? { before } : {}),
        }),
      });
    },
  );
  app.get(
    `${BASE}/block-catalog/versions/:version`,
    doc('Block catalog', 'Get a block catalog version', { ok: blockCatalogDocs.blockCatalog }),
    requireScope(SCOPES.previewRead),
    async (c) =>
      c.json(
        await getBlockCatalog(ctx, scopeOf(c), versionOf(c.req.param('version'), 'version') ?? 0),
      ),
  );
  app.get(
    `${BASE}/block-catalog/usage`,
    doc('Block catalog', 'Count block usage', {
      ok: blockCatalogDocs.blockCatalogUsage,
      description:
        'How many entries use each block of the catalog in force, per target type: current ' +
        'versions outside the trash, once per entry, a block stored under a former id counting ' +
        `as its block. Reads up to ${MAX_BLOCK_USAGE_SCAN} entries per type; past that ` +
        '`complete` is false and the counts are a lower bound. Types the caller can’t read ' +
        'are left out.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getBlockUsage(ctx, c.get('principal'), scopeOf(c))),
  );
  return app;
}
