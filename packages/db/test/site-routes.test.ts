import { env } from 'cloudflare:workers';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  type AppContext,
  createContentType,
  createSpace,
  getContentType,
  listDeliveredRoutes,
  publishContentType,
  updateContentType,
} from '@contentworker/application';
import type { FieldDefinition } from '@contentworker/domain';
import { FixedClock } from '@contentworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * Site routes on D1 (0020_content_type_published_url_pattern): a content type's published URL
 * pattern survives a revision until the next publish, and the migration's backfill publishes the
 * pattern of the types already published. Each test makes its own space: the file shares one
 * database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `routes-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Routes', defaultLocale: 'en-US' });
  return { ctx, spaceId, scope: { spaceId, environmentId: 'main' } };
}

const slug = {
  apiId: 'slug',
  name: 'Slug',
  type: 'Slug',
  localized: false,
  required: false,
  position: 0,
} as FieldDefinition;

describe('site routes on D1', () => {
  it('keeps the published pattern through a revision, until the next publish', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'slug',
      urlPattern: '/blog/{slug}',
      fields: [slug],
    });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([]);
    await publishContentType(ctx, scope, 'article');
    await updateContentType(ctx, scope, 'article', { urlPattern: '/news/{slug}' });
    expect(await getContentType(ctx, scope, 'article')).toMatchObject({
      status: 'draft',
      urlPattern: '/news/{slug}',
      publishedUrlPattern: '/blog/{slug}',
    });
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'article', urlPattern: '/blog/{slug}' },
    ]);
    await publishContentType(ctx, scope, 'article');
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([
      { contentType: 'article', urlPattern: '/news/{slug}' },
    ]);
    await updateContentType(ctx, scope, 'article', { urlPattern: null });
    await publishContentType(ctx, scope, 'article');
    expect(await listDeliveredRoutes(ctx, scope)).toEqual([]);
    expect(await getContentType(ctx, scope, 'article')).not.toHaveProperty('publishedUrlPattern');
  });

  it('backfills the published pattern of the types already published', async () => {
    const { spaceId } = await harness();
    // Rows as the code before 0020 wrote them: no published pattern.
    const insert = (apiId: string, status: string, urlPattern: string | null) =>
      testDb
        .prepare(
          `insert into content_types (space_id, environment_id, api_id, name, display_field, fields, version, status, url_pattern)
           values (?, 'main', ?, ?, 'slug', '[]', 1, ?, ?)`,
        )
        .bind(spaceId, apiId, apiId, status, urlPattern)
        .run();
    await insert('live', 'published', '/{slug}');
    await insert('plain', 'published', null);
    await insert('draft', 'draft', '/drafts/{slug}');

    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const m = migrations.find((x) => x.name.startsWith('0020_'));
    const updates = (m?.queries ?? []).filter((q) => /UPDATE `content_types`/.test(q));
    expect(updates).toHaveLength(1);
    for (const q of updates) await testDb.prepare(q).run();

    const rows = await testDb
      .prepare(
        'select api_id, published_url_pattern from content_types where space_id = ? order by api_id',
      )
      .bind(spaceId)
      .all();
    expect(rows.results).toEqual([
      { api_id: 'draft', published_url_pattern: null },
      { api_id: 'live', published_url_pattern: '/{slug}' },
      { api_id: 'plain', published_url_pattern: null },
    ]);
  });
});
