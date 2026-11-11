import { compareEnvironments, comparisonFor, mergeEnvironments } from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { mergeBody, parseBody } from '../../validation';
import { actingCtx } from './shared';

export function environmentMergeRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- branch compare/merge (environments) -------------------------------
  app.get('/spaces/:space/compare', requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      comparisonFor(
        c.get('principal'),
        await compareEnvironments(
          ctx,
          c.req.param('space'),
          c.req.query('source') ?? '',
          c.req.query('target') ?? '',
        ),
      ),
    ),
  );
  // Apply selected content types/entries from source→target (additive).
  app.post('/spaces/:space/merge', requireScope(SCOPES.contentManage), async (c) => {
    const body = await parseBody(c, mergeBody);
    return c.json(
      await mergeEnvironments(
        actingCtx(ctx, c),
        c.get('principal'),
        c.req.param('space'),
        body.source,
        body.target,
        { contentTypes: body.contentTypes, entries: body.entries },
      ),
    );
  });

  return app;
}
