import {
  createConcept,
  createScheme,
  createTag,
  deleteConcept,
  deleteScheme,
  deleteTag,
  listConcepts,
  listSchemes,
  listTags,
  setConceptBroader,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { broaderBody, conceptBody, parseBody, schemeBody, tagBody } from '../../validation';
import { BASE, scopeOf } from './shared';

export function taxonomyRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  // --- taxonomy (controlled vocabulary) ----------------------------------
  app.get(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listSchemes(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createScheme(ctx, scopeOf(c), await parseBody(c, schemeBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/schemes/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteScheme(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listConcepts(ctx, scopeOf(c), c.req.query('scheme')) }),
  );
  app.post(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createConcept(ctx, scopeOf(c), await parseBody(c, conceptBody)), 201),
  );
  app.put(
    `${BASE}/taxonomy/concepts/:id/broader`,
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, broaderBody);
      return c.json(
        await setConceptBroader(ctx, scopeOf(c), c.req.param('id'), body.broaderId ?? null),
      );
    },
  );
  app.delete(`${BASE}/taxonomy/concepts/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteConcept(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/tags`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listTags(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/tags`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createTag(ctx, scopeOf(c), await parseBody(c, tagBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/tags/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteTag(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
