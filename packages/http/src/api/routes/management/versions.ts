import {
  diffVersions,
  getEntry,
  getVersion,
  listVersions,
  restoreVersion,
} from '@contentworker/application';
import {
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
  SCOPES,
} from '@contentworker/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, requireScope } from '../../auth';
import { doc } from '../../docs/openapi';
import { BASE, entryAccess, expectedVersionOf, scopeOf } from './shared';

export function versionsRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const { authorizeEntryRead } = entryAccess(ctx);
  const app = new Hono<AuthVars>();

  // --- entry version history ---------------------------------------------
  // Version snapshots carry raw field values, so every read authorizes the
  // entry's content type and masks denied fields — matching GET /entries/:id.
  app.get(`${BASE}/entries/:id/versions`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const items = (await listVersions(ctx, scopeOf(c), c.req.param('id'))).map((v) => ({
      ...v,
      fields: maskDeniedFields(principal, type, v.fields),
    }));
    return c.json({ items });
  });
  // A field-by-field diff between two versions (?from=&to=).
  app.get(`${BASE}/entries/:id/versions/diff`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const diff = await diffVersions(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.query('from')),
      Number(c.req.query('to')),
    );
    // Drop denied fields from the diff so they can't leak via before/after.
    const allowed = maskDeniedFields(
      principal,
      type,
      Object.fromEntries(diff.changes.map((ch) => [ch.field, ch])),
    );
    return c.json({ ...diff, changes: Object.values(allowed) });
  });
  app.get(`${BASE}/entries/:id/versions/:version`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const version = await getVersion(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.param('version')),
    );
    return c.json({
      ...version,
      fields: maskDeniedFields(c.get('principal'), type, version.fields),
    });
  });
  // Restore copies an old version's fields into a NEW draft version. It must pass
  // the same write authorization as a normal edit, so a role with denied/
  // read-only fields can't resurrect them by restoring, or write an ungranted type.
  app.post(
    `${BASE}/entries/:id/versions/:version/restore`,
    doc('Entries', 'Restore a version', {
      description: "Copies the version's fields into a new draft version.",
      query: {
        expectedVersion:
          "The entry's currentVersion as the caller read it; 409 if it has changed since",
      },
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const principal = c.get('principal');
      const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      authorizeContent(principal, 'write', entry.contentTypeApiId);
      const target = await getVersion(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        Number(c.req.param('version')),
      );
      assertWritableFields(principal, entry.contentTypeApiId, target.fields);
      return c.json(
        await restoreVersion(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          Number(c.req.param('version')),
          expectedVersionOf(c),
        ),
      );
    },
  );

  return app;
}
