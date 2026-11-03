import {
  canvasToEntry,
  createEntry,
  createPreviewLink,
  draftEntry,
  getEntry,
  resolveEmbed,
  validateEntry,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
  ValidationError,
} from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import * as embedDocs from '../../docs/schemas/embeds';
import * as entryDocs from '../../docs/schemas/entries';
import {
  canvasBody,
  createEntryBody,
  draftEntryBody,
  parseBody,
  previewLinkBody,
  resolveEmbedBody,
  validateEntryBody,
} from '../../validation';
import { actingCtx, BASE, entryAccess, scopeOf } from './shared';

export function entriesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher, ai } = deps;
  const { guardEntry } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- entries ------------------------------------------------------------

  app.post(
    `${BASE}/entries`,
    doc('Entries', 'Create a draft entry', {
      body: createEntryBody,
      ok: entryDocs.createdEntry,
      status: 201,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, createEntryBody);
      const principal = c.get('principal');
      authorizeContent(principal, 'write', body.contentTypeApiId);
      assertWritableFields(principal, body.contentTypeApiId, body.fields ?? {});
      const view = await createEntry(
        actingCtx(ctx, c),
        scopeOf(c),
        body as Parameters<typeof createEntry>[2],
      );
      return c.json(view, 201);
    },
  );
  // A dry run of a create or an update: the same checks, the same errors, nothing written. Gated
  // like the save it stands in for, so it tells a caller nothing a save wouldn't.
  app.post(
    `${BASE}/entries/validate`,
    doc('Entries', 'Validate an entry without saving it', {
      body: validateEntryBody,
      ok: entryDocs.entryValidation,
      description:
        'Runs exactly the checks a save makes, in the same order: with `contentTypeApiId`, those ' +
        'of creating an entry (defaults applied); with `entryId`, those of saving a new version ' +
        'of it. A pass answers 200 with the fields as they would be stored; a failure answers ' +
        'exactly as the save would (422 with field issues or a plugin refusal, 409 for a unique ' +
        'value another entry holds, 400 `invalid_state` for an entry in the trash, 404 for an ' +
        'unknown type or entry). Nothing is written. ' +
        'Plugins on `entry:beforeSave` run only when they hold no capabilities; the rest are ' +
        'named in `skippedHooks`.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, validateEntryBody);
      const principal = c.get('principal');
      const fields = body.fields ?? {};
      if (body.entryId !== undefined) {
        if (principal.contentGrants) {
          const { entry } = await getEntry(ctx, scopeOf(c), body.entryId);
          authorizeContent(principal, 'write', entry.contentTypeApiId);
          assertWritableFields(principal, entry.contentTypeApiId, fields);
        }
        return c.json(await validateEntry(ctx, scopeOf(c), { entryId: body.entryId, fields }));
      }
      const contentTypeApiId = body.contentTypeApiId ?? '';
      authorizeContent(principal, 'write', contentTypeApiId);
      assertWritableFields(principal, contentTypeApiId, fields);
      return c.json(await validateEntry(ctx, scopeOf(c), { contentTypeApiId, fields }));
    },
  );
  // AI-draft an entry's fields. Generated values pass the same validators a
  // human write does, so an agent can't produce an entry a person couldn't.
  app.post(`${BASE}/entries/generate`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, draftEntryBody);
    authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
    return c.json(await draftEntry(ctx, ai, scopeOf(c), body));
  });
  // Canvas: map free-form prose into structured fields (same validation gate).
  app.post(`${BASE}/entries/canvas`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, canvasBody);
    authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
    return c.json(await canvasToEntry(ctx, ai, scopeOf(c), body));
  });
  // Rich text's external media: a pasted URL becomes an `embed` node's data. Scoped like a
  // content write, since that is the only thing the answer is for.
  app.post(
    `${BASE}/embeds/resolve`,
    doc('Entries', 'Resolve a media URL for a rich-text embed', {
      body: resolveEmbedBody,
      ok: embedDocs.resolvedEmbed,
      description:
        "Asks an allowed provider's oEmbed endpoint (YouTube, Vimeo, X, Bluesky, Mastodon, " +
        'Spotify, SoundCloud) about an https URL and returns the data of an `embed` rich-text ' +
        "node: title, author, thumbnail and size. The provider's player HTML is discarded; " +
        'channels render the embed themselves. A URL that is not https or not on an allowed ' +
        'provider is refused (422). A provider that does not answer is not an error: `resolved` is ' +
        'false and the embed holds the URL and provider alone, which is valid to store.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, resolveEmbedBody);
      if (!deps.remoteFetcher) {
        throw new ValidationError([
          { field: 'url', message: 'This deployment cannot fetch embed metadata' },
        ]);
      }
      return c.json(await resolveEmbed(deps.remoteFetcher, body));
    },
  );
  app.get(
    `${BASE}/entries/:id`,
    doc('Entries', 'Get an entry (draft state)', { ok: entryDocs.entry }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const view = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      const principal = c.get('principal');
      authorizeContent(principal, 'read', view.entry.contentTypeApiId);
      return c.json({
        ...view,
        fields: maskDeniedFields(principal, view.entry.contentTypeApiId, view.fields),
      });
    },
  );
  app.post(`${BASE}/entries/:id/preview-link`, requireScope(SCOPES.contentWrite), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const body = await parseBody(c, previewLinkBody);
    const origin = c.req.header('origin') ?? '';
    const link = await createPreviewLink(ctx, hasher, scopeOf(c), c.req.param('id'), {
      ttlHours: body.ttlHours,
      previewBaseUrl: body.previewBaseUrl ?? origin,
    });
    return c.json(link, 201);
  });

  return app;
}
