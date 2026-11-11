import {
  applyEntryTags,
  autofillField,
  suggestEntryTags,
  summarizeEntry,
  translateEntry,
} from '@contentworker/application';
import { SCOPES } from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import {
  applyTagsBody,
  autofillBody,
  parseBody,
  summarizeBody,
  tierOnlyBody,
  translateBody,
} from '../../validation';
import { actingCtx, BASE, scopeOf } from './shared';

export function aiContentRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, ai } = deps;
  const app = new Hono<AuthVars>();

  // --- AI content operations over an entry -------------------------------
  // Each use-case authorizes the entry for the principal (read, and write when it applies) and
  // keeps the fields its role denies away from the model and out of the answer.
  app.post(`${BASE}/entries/:id/translate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await translateEntry(
        actingCtx(ctx, c),
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, translateBody),
        { principal: c.get('principal') },
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/summarize`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await summarizeEntry(
        actingCtx(ctx, c),
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, summarizeBody),
        { principal: c.get('principal') },
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/autofill`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await autofillField(
        actingCtx(ctx, c),
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, autofillBody),
        { principal: c.get('principal') },
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/suggest-tags`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await suggestEntryTags(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, tierOnlyBody),
        { principal: c.get('principal') },
      ),
    ),
  );
  // Persists a reviewed tag suggestion exactly as approved (no model re-run).
  app.post(`${BASE}/entries/:id/apply-tags`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await applyEntryTags(
        actingCtx(ctx, c),
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, applyTagsBody),
        { principal: c.get('principal') },
      ),
    ),
  );

  return app;
}
