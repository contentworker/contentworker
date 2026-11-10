import { getEntryBlockLocks, setEntryBlockLocks } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as blockLockDocs from '../../docs/schemas/block-locks';
import { blockLocksSetBody, parseBody } from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

/**
 * Locked regions: part of one entry's blocks editors can't restructure. Reading them takes what
 * reading the entry does; setting them `content:write` and the `lock` action on the entry's type
 * (checked by the use-case, which reads the type), for locking and unlocking alike.
 */
export function entryBlockLocksRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/entries/:id/block-locks`,
    doc('Entries', 'Get an entry’s locked regions', {
      ok: blockLockDocs.entryBlockLocks,
      description:
        'The regions of its blocks editors can’t restructure, who locked each and when, and ' +
        'which are stale (their blocks are gone; they never block a save). `version` is what a ' +
        'set sends back as `expectedVersion`.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      return c.json(
        await getEntryBlockLocks(ctx, c.get('principal'), scopeOf(c), c.req.param('id')),
      );
    },
  );
  app.put(
    `${BASE}/entries/:id/block-locks`,
    doc('Entries', 'Set an entry’s locked regions', {
      body: blockLocksSetBody,
      ok: blockLockDocs.entryBlockLocksSet,
      description:
        'Replaces the whole list: a lock left out is unlocked. Each region is one block or a run ' +
        'of neighbours in one slot, by `_key`, in a top-level blocks field; a block belongs to at ' +
        'most one region. A new lock is stamped with the caller and now; one the entry already ' +
        'holds keeps its stamp. Makes no version. Needs the `lock` action on the entry’s type ' +
        '(403 `content:lock:<type>`), whoever locked. 422 naming each lock whose keys the entry ' +
        'doesn’t hold as a run or that overlaps another; 409 when `expectedVersion` is stale or ' +
        'a save or another set commits first.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await setEntryBlockLocks(
          actingCtx(ctx, c),
          c.get('principal'),
          scopeOf(c),
          c.req.param('id'),
          await parseBody(c, blockLocksSetBody),
        ),
      ),
  );
  return app;
}
