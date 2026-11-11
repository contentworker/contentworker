import {
  assetSearchDeps,
  canvasToEntry,
  createEntry,
  createPreviewLink,
  draftEntry,
  getEntry,
  imageSearchFor,
  moveEntry,
  resolveEmbed,
  validateEntry,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  deniedFieldsFor,
  maskDeniedFields,
  SCOPES,
  unwritableFieldsFor,
  ValidationError,
  withAuthorIdsFor,
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
  moveEntryBody,
  parseBody,
  previewLinkBody,
  resolveEmbedBody,
  validateEntryBody,
} from '../../validation';
import { actingCtx, BASE, entryAccess, scopeOf } from './shared';

export function entriesRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher, ai } = deps;
  const { guardEntry } = entryAccess(ctx);
  // Drafted blocks find their images as the asset search route does.
  const assetSearch = deps.assetSearch ?? assetSearchDeps(deps.rag);
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
      // A field it may not read is never named in a refusal, only counted.
      const view = await createEntry(
        actingCtx(ctx, c),
        scopeOf(c),
        body as Parameters<typeof createEntry>[2],
        { unreadable: deniedFieldsFor(principal, body.contentTypeApiId) },
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
        let unwritable: readonly string[] = [];
        let unreadable: readonly string[] = [];
        let type = '';
        if (principal.contentGrants) {
          const stored = await getEntry(ctx, scopeOf(c), body.entryId);
          type = stored.entry.contentTypeApiId;
          authorizeContent(principal, 'write', type);
          assertWritableFields(principal, type, fields, stored.fields);
          unwritable = unwritableFieldsFor(principal, type);
          unreadable = deniedFieldsFor(principal, type);
        }
        const result = await validateEntry(
          ctx,
          scopeOf(c),
          { entryId: body.entryId, fields },
          { unwritable, unreadable },
        );
        // Judged with the stored values of the fields this writer may not write; answered (and
        // refused) without the ones it may not read.
        return c.json({
          ...result,
          fields: maskDeniedFields(principal, type, result.fields),
        });
      }
      const contentTypeApiId = body.contentTypeApiId ?? '';
      authorizeContent(principal, 'write', contentTypeApiId);
      assertWritableFields(principal, contentTypeApiId, fields);
      return c.json(
        await validateEntry(
          ctx,
          scopeOf(c),
          { contentTypeApiId, fields },
          { unreadable: deniedFieldsFor(principal, contentTypeApiId) },
        ),
      );
    },
  );
  app.post(
    `${BASE}/entries/:id/move`,
    doc('Entries', 'Move an entry in its content type’s manual order', {
      body: moveEntryBody,
      ok: entryDocs.movedEntry,
      description:
        'Puts the entry right after another of the same type (`{ "after": id }`, `null` for ' +
        'first) or right before one (`{ "before": id }`, `null` for last). The order is what ' +
        '`order=sys.position` sorts by; an entry never moved sorts by its id, so creation order. ' +
        'A move is live, like a menu’s order: no new version, no publish, and Delivery serves ' +
        'a published entry’s new place at once (`entry.moved`). Moving an entry to where it ' +
        'already is writes nothing. 422 for an anchor that is the entry itself, of another type ' +
        'or in the trash; 400 `invalid_state` for an entry in the trash; 409 when the order kept ' +
        'changing under three attempts. Needs write on the type.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const id = c.req.param('id');
      await guardEntry(c, id, 'write');
      const body = await parseBody(c, moveEntryBody);
      return c.json(await moveEntry(actingCtx(ctx, c), scopeOf(c), id, body));
    },
  );

  // AI-draft an entry's fields. Generated values pass the same validators a
  // human write does, so an agent can't produce an entry a person couldn't.
  app.post(
    `${BASE}/entries/generate`,
    doc('Entries', 'Draft an entry’s fields with AI', {
      body: draftEntryBody,
      ok: entryDocs.draftResult,
      description:
        'Asks the model for the type’s scalar fields (text, numbers, booleans, dates) and its ' +
        'top-level blocks fields (composed from the blocks the block rules allow there, images ' +
        'found in the asset library by what they show), then judges the answer as a create ' +
        'would, except that it isn’t required to fill what it can’t (rich text, links, slugs, ' +
        'locations). Nothing is saved: create the entry with the answer. 422 when the draft ' +
        'breaks a rule; 429 over the space’s AI budget. To fill one blocks field or slot of an ' +
        'existing entry, use `POST …/entries/blocks/generate`.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, draftEntryBody);
      authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
      return c.json(
        await draftEntry(ctx, ai, scopeOf(c), body, {
          assets: imageSearchFor(c.get('principal'), assetSearch),
        }),
      );
    },
  );
  // Canvas: map free-form prose into structured fields (same validation gate).
  app.post(
    `${BASE}/entries/canvas`,
    doc('Entries', 'Map prose into an entry’s fields with AI', {
      body: canvasBody,
      ok: entryDocs.draftResult,
      description:
        'Maps free-form prose into the type’s fields, keeping the author’s wording where it ' +
        'fits a field, with the same fields, checks and answer as `POST …/entries/generate`. ' +
        'The prose is treated as content, never as instructions. Nothing is saved.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, canvasBody);
      authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
      return c.json(
        await canvasToEntry(ctx, ai, scopeOf(c), body, {
          assets: imageSearchFor(c.get('principal'), assetSearch),
        }),
      );
    },
  );
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
        entry: withAuthorIdsFor(principal, view.entry),
        fields: maskDeniedFields(principal, view.entry.contentTypeApiId, view.fields),
      });
    },
  );
  app.post(
    `${BASE}/entries/:id/preview-link`,
    doc('Entries', 'Mint a preview link', {
      description:
        'An expiring token that reads this one entry, drafts included (default 72 hours). `url` ' +
        'is the entry on the Preview API; when its content type has a `preview.urlTemplate`, ' +
        '`frontendUrl` is that template filled for the entry and the token.',
      body: previewLinkBody,
      ok: entryDocs.previewLink,
      status: 201,
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'read');
      const body = await parseBody(c, previewLinkBody);
      const origin = c.req.header('origin') ?? '';
      const link = await createPreviewLink(ctx, hasher, scopeOf(c), c.req.param('id'), {
        ttlHours: body.ttlHours,
        previewBaseUrl: body.previewBaseUrl ?? origin,
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
      });
      return c.json(link, 201);
    },
  );

  return app;
}
