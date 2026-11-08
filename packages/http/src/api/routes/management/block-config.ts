import { getBlockConfig, getEffectiveBlockRules, setBlockConfig } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as blockConfigDocs from '../../docs/schemas/block-config';
import { blockConfigSetBody, parseBody } from '../../validation';
import { BASE, scopeOf } from './shared';

/**
 * The block config: what an environment's admins allow of the block catalog, per target and per
 * slot, only ever narrower than the code. Reading it takes what reading the catalog does; setting
 * it what pushing the catalog does. Every entry save is held to it.
 */
export function blockConfigRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/block-config`,
    doc('Block config', 'Get the block config', {
      ok: blockConfigDocs.blockConfig,
      description:
        'The narrowings in force, by target and by block slot, and who set them when. Version 0 ' +
        'and empty before the first set.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getBlockConfig(ctx, scopeOf(c))),
  );
  app.put(
    `${BASE}/block-config`,
    doc('Block config', 'Set the block config', {
      body: blockConfigSetBody,
      ok: blockConfigDocs.blockConfigSet,
      description:
        'Replaces the config with a new version, checked against the block catalog in force: ' +
        'each target, block and slot it names must be in the catalog, and each narrowing only ' +
        'tighter than the code (a subset of the blocks it allows, a min no lower, a max no ' +
        'higher). Setting the config in force again writes nothing. 422 naming each part that ' +
        'widens or names something unknown; 409 when `expectedVersion` is stale or another set ' +
        'commits first.',
    }),
    requireScope(SCOPES.contentManage),
    async (c) =>
      c.json(
        await setBlockConfig(
          ctx,
          c.get('principal'),
          scopeOf(c),
          await parseBody(c, blockConfigSetBody),
        ),
      ),
  );
  app.get(
    `${BASE}/block-config/effective`,
    doc('Block config', 'Get the block rules in force', {
      ok: blockConfigDocs.effectiveBlockRules,
      description:
        'Every catalog target and block slot with the config laid over the code: the blocks it ' +
        'takes, its bounds and whether it is locked. `stale` lists config parts the catalog no ' +
        'longer has; they are ignored.',
    }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getEffectiveBlockRules(ctx, scopeOf(c))),
  );
  return app;
}
